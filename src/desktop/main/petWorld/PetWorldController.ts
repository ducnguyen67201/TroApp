import { randomUUID } from 'node:crypto';
import type { AuthResult } from '#contracts/AuthSession.js';
import {
  PetAction,
  PetBackdropId,
  PetFailure,
  type PetCommand,
  type PetReply,
} from '#contracts/Pet.js';
import {
  PetWorldCommandKind,
  PetWorldAssetId,
  PetWorldCommandSchema,
  PetWorldFailure,
  PetWorldTiming,
  isPetWorldMutationCommand,
  type PetCatalog,
  type PetOwnWorld,
  type PetWorldCommand,
  type PetWorldMutationCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import type { AccountTransitionGate } from '../accounts/AccountTransitionGate.js';
import type { PetController } from '../pets/PetController.js';
import type { PetWorldApiClient } from './PetWorldApiClient.js';
import {
  createPetWorldLocalState,
  type PetWorldLocalState,
  type PetWorldLocalStore,
} from './PetWorldLocalState.js';

function isUncertainReply(reply: PetWorldReply): boolean {
  return reply.kind === 'failed' && reply.code === PetWorldFailure.UNAVAILABLE;
}

function resolveBackdrop(catalog: PetCatalog | null, world: PetOwnWorld): PetBackdropId | null {
  const assetId = catalog?.items.find((item) => item.id === world.profile?.backdropItemId)?.assetId;
  return Object.values(PetBackdropId).find((backdropId) => backdropId === assetId) ?? null;
}

interface PetWorldAccountRequest {
  accountId: string;
  generation: number;
  signal: AbortSignal;
  isTrusted: () => boolean;
}

/** Owns sync and uncertain intents. Accounting and authorization remain on the server. */
export class PetWorldController {
  private accountId: string | null = null;
  private generation = 0;
  private requests = new AbortController();
  private ready: Promise<void> = Promise.resolve();
  private queuedWork: Promise<unknown> = Promise.resolve();
  private state = createPetWorldLocalState();
  private catalog: PetCatalog | null = null;
  private walletRevision = -1;
  private canPoll = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: Pick<PetWorldApiClient, 'execute'>,
    private readonly accounts: AccountTransitionGate,
    private readonly store: PetWorldLocalStore,
    private readonly pets: Pick<
      PetController,
      'setAccount' | 'readSnapshot' | 'applyCloudAppearance' | 'executeCommand'
    >,
    private readonly readSession: () => Promise<AuthResult>,
    private readonly createId: () => string = randomUUID,
  ) {}

  async setAccount(accountId: string | null): Promise<void> {
    if (this.accountId === accountId) {
      await this.ready;
      return;
    }
    this.dispose();
    this.accountId = accountId;
    const generation = this.generation;
    this.ready = accountId ? this.loadAccount(accountId, generation) : Promise.resolve();
    await this.ready;
    if (accountId && generation === this.generation) {
      this.timer = setInterval(() => {
        if (this.canPoll && this.pets.readSnapshot().isVisible) {
          void this.execute({ kind: PetWorldCommandKind.OWN_WORLD }, () => true);
        }
      }, PetWorldTiming.REFRESH_MS);
      this.timer.unref();
    }
  }

  async execute(raw: unknown, isTrusted: () => boolean): Promise<PetWorldReply> {
    if (!isTrusted()) {
      return { kind: 'failed', code: PetWorldFailure.FORBIDDEN };
    }
    const parsed = PetWorldCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'failed', code: PetWorldFailure.INVALID };
    }
    return this.accounts.runRequest<PetWorldReply>(
      async () => {
        try {
          const startingGeneration = this.generation;
          const session = await this.readSession();
          const hasCurrentAccount =
            session.kind === 'signed-in' && this.accountId === session.user.id;
          if ((startingGeneration !== this.generation && !hasCurrentAccount) || !isTrusted()) {
            return { kind: 'failed', code: PetWorldFailure.STALE };
          }
          if (session.kind !== 'signed-in') {
            return { kind: 'failed', code: PetWorldFailure.UNAUTHORIZED };
          }
          await this.setAccount(session.user.id);
          const generation = this.generation;
          const request: PetWorldAccountRequest = {
            accountId: session.user.id,
            generation,
            signal: this.requests.signal,
            isTrusted,
          };
          const command: PetWorldCommand =
            parsed.data.kind === PetWorldCommandKind.BUY_ITEM
              ? {
                  ...parsed.data,
                  supportedAssetIds:
                    parsed.data.supportedAssetIds ?? Object.values(PetWorldAssetId),
                }
              : parsed.data;
          const operation = this.queuedWork.then(async (): Promise<PetWorldReply> => {
            if (!this.isCurrentRequest(request)) {
              return { kind: 'failed', code: PetWorldFailure.STALE };
            }
            const reply = await this.executeForAccount(command, request);
            return this.isCurrentRequest(request)
              ? reply
              : { kind: 'failed', code: PetWorldFailure.STALE };
          });
          this.queuedWork = operation.catch(() => {});
          return await operation;
        } catch {
          return { kind: 'failed', code: PetWorldFailure.UNAVAILABLE };
        }
      },
      { kind: 'failed', code: PetWorldFailure.UNAVAILABLE },
    );
  }

  async readPending(isTrusted: () => boolean): Promise<PetWorldCommand[]> {
    if (!isTrusted()) {
      return [];
    }
    return this.accounts.runRequest(async () => {
      try {
        const startingGeneration = this.generation;
        const session = await this.readSession();
        if (
          session.kind !== 'signed-in' ||
          (startingGeneration !== this.generation && this.accountId !== session.user.id) ||
          !isTrusted()
        ) {
          return [];
        }
        await this.setAccount(session.user.id);
        return isTrusted() && this.accountId === session.user.id
          ? structuredClone(this.state.pending)
          : [];
      } catch {
        return [];
      }
    }, []);
  }

  /** Existing picker edits use the cloud profile for owners and local settings for teacher pets. */
  async adoptPet(
    command: Extract<PetCommand, { kind: typeof PetAction.ADOPT }>,
    isTrusted: () => boolean,
  ): Promise<PetReply> {
    return this.accounts.runRequest(() => this.adoptPetForAccount(command, isTrusted), {
      kind: 'failed',
      reason: PetFailure.UNAVAILABLE,
    });
  }

  private async adoptPetForAccount(
    command: Extract<PetCommand, { kind: typeof PetAction.ADOPT }>,
    isTrusted: () => boolean,
  ): Promise<PetReply> {
    const current = await this.execute({ kind: PetWorldCommandKind.OWN_WORLD }, isTrusted);
    if (current.kind === 'failed' && current.code === PetWorldFailure.FORBIDDEN) {
      return isTrusted()
        ? this.pets.executeCommand(command)
        : { kind: 'failed', reason: PetFailure.UNAVAILABLE };
    }
    if (current.kind !== 'world' || !current.world.profile) {
      return { kind: 'failed', reason: PetFailure.UNAVAILABLE };
    }
    const profile = current.world.profile;
    if (profile.activePetId !== command.petId || profile.names[command.petId] !== command.name) {
      const result = await this.execute(
        {
          kind: PetWorldCommandKind.SET_PET_PROFILE,
          requestId: this.createId(),
          expectedWorldRevision: profile.revision,
          activePetId: command.petId,
          name: command.name,
        },
        isTrusted,
      );
      if (result.kind === 'failed') {
        return { kind: 'failed', reason: PetFailure.SAVE };
      }
      const confirmed = await this.execute({ kind: PetWorldCommandKind.OWN_WORLD }, isTrusted);
      if (
        confirmed.kind !== 'world' ||
        confirmed.world.profile?.activePetId !== command.petId ||
        confirmed.world.profile.names[command.petId] !== command.name
      ) {
        return { kind: 'failed', reason: PetFailure.SAVE };
      }
    }
    return isTrusted()
      ? this.pets.executeCommand(command)
      : { kind: 'failed', reason: PetFailure.UNAVAILABLE };
  }

  dispose(): void {
    this.generation += 1;
    this.requests.abort();
    this.requests = new AbortController();
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
    this.accountId = null;
    this.state = createPetWorldLocalState();
    this.catalog = null;
    this.walletRevision = -1;
    this.canPoll = true;
    this.ready = Promise.resolve();
  }

  private async loadAccount(accountId: string, generation: number): Promise<void> {
    /* An old window's atomic save must finish before this window reads its intents. */
    await this.queuedWork;
    if (generation !== this.generation || accountId !== this.accountId) {
      return;
    }
    await this.pets.setAccount(accountId);
    if (generation !== this.generation || accountId !== this.accountId) {
      return;
    }
    const state = await this.store.readState(accountId);
    if (generation !== this.generation) {
      return;
    }
    this.state = state;
    if (state.appearance) {
      this.pets.applyCloudAppearance(accountId, state.appearance);
    }
  }

  private async executeForAccount(
    command: PetWorldCommand,
    request: PetWorldAccountRequest,
  ): Promise<PetWorldReply> {
    const { accountId, generation, signal } = request;
    if (isPetWorldMutationCommand(command)) {
      if (!(await this.retainIntent(accountId, generation, command))) {
        return { kind: 'failed', code: PetWorldFailure.REQUEST_CONFLICT };
      }
    }
    /* Persistence may outlive a window or account. Keep its intent without dispatching it. */
    if (!this.isCurrentRequest(request)) {
      return { kind: 'failed', code: PetWorldFailure.STALE };
    }
    let reply = await this.api.execute(command, signal);
    if (!this.isCurrentRequest(request)) {
      return { kind: 'failed', code: PetWorldFailure.STALE };
    }
    if (
      command.kind === PetWorldCommandKind.OWN_WORLD &&
      reply.kind === 'failed' &&
      reply.code === PetWorldFailure.FORBIDDEN
    ) {
      this.canPoll = false;
    }
    if (isPetWorldMutationCommand(command) && !isUncertainReply(reply)) {
      try {
        await this.saveLocalState(accountId, generation, {
          ...this.state,
          pending: this.state.pending.filter(
            (intent) => !('requestId' in intent) || intent.requestId !== command.requestId,
          ),
        });
      } catch {
        console.warn('pet.world.local.failed', { stage: 'resolve-intent' });
      }
    }
    if (!this.isCurrentRequest(request)) {
      return { kind: 'failed', code: PetWorldFailure.STALE };
    }
    if (reply.kind === 'catalog') {
      this.catalog = reply.catalog;
    }
    if (
      reply.kind === 'world' &&
      !reply.world.profile &&
      command.kind === PetWorldCommandKind.OWN_WORLD
    ) {
      const preferences = this.pets.readSnapshot().preferences;
      const prior = this.state.pending.find(
        (intent) => intent.kind === PetWorldCommandKind.INITIALIZE_WORLD,
      );
      const initialization: PetWorldCommand = prior ?? {
        kind: PetWorldCommandKind.INITIALIZE_WORLD,
        requestId: this.createId(),
        activePetId: preferences.activePetId,
        names: preferences.names,
      };
      const initialized = await this.executeForAccount(initialization, request);
      if (initialized.kind === 'failed') {
        return initialized;
      }
      if (!this.isCurrentRequest(request)) {
        return { kind: 'failed', code: PetWorldFailure.STALE };
      }
      reply = await this.api.execute({ kind: PetWorldCommandKind.OWN_WORLD }, signal);
    }
    if (reply.kind === 'world') {
      return (await this.acceptWorld(request, reply.world))
        ? reply
        : { kind: 'failed', code: PetWorldFailure.STALE };
    }
    if (
      isPetWorldMutationCommand(command) &&
      reply.kind !== 'failed' &&
      command.kind !== PetWorldCommandKind.GRANT_POINTS &&
      command.kind !== PetWorldCommandKind.REVERSE_GRANT &&
      command.kind !== PetWorldCommandKind.VOID_RECOGNITION
    ) {
      try {
        const latest = await this.api.execute({ kind: PetWorldCommandKind.OWN_WORLD }, signal);
        if (latest.kind === 'world') {
          await this.acceptWorld(request, latest.world);
        }
      } catch {
        console.warn('pet.world.local.failed', { stage: 'refresh-after-commit' });
      }
    }
    return reply;
  }

  private async retainIntent(
    accountId: string,
    generation: number,
    command: PetWorldMutationCommand,
  ): Promise<boolean> {
    const existing = this.state.pending.find(
      (intent) => 'requestId' in intent && intent.requestId === command.requestId,
    );
    if (existing) {
      const canonical = (intent: PetWorldCommand): string =>
        JSON.stringify(
          intent.kind === PetWorldCommandKind.GRANT_POINTS
            ? { ...intent, studentIds: [...intent.studentIds].sort() }
            : intent,
        );
      return canonical(existing) === canonical(command);
    }
    await this.saveLocalState(accountId, generation, {
      ...this.state,
      pending: [...this.state.pending, command],
    });
    return true;
  }

  private async acceptWorld(request: PetWorldAccountRequest, world: PetOwnWorld): Promise<boolean> {
    const { accountId, generation, signal } = request;
    if (
      !this.isCurrentRequest(request) ||
      world.studentId !== accountId ||
      world.wallet.revision < this.walletRevision ||
      (world.profile &&
        this.state.appearance &&
        world.profile.revision < this.state.appearance.revision)
    ) {
      return false;
    }
    this.walletRevision = world.wallet.revision;
    this.canPoll = true;
    if (!world.profile) {
      return true;
    }
    if (!this.catalog) {
      const reply = await this.api.execute({ kind: PetWorldCommandKind.CATALOG }, signal);
      if (!this.isCurrentRequest(request)) {
        return false;
      }
      if (reply.kind === 'catalog') {
        this.catalog = reply.catalog;
      }
    }
    const appearance = {
      revision: world.profile.revision,
      activePetId: world.profile.activePetId,
      names: world.profile.names,
      backdropId: resolveBackdrop(this.catalog, world),
    };
    await this.saveLocalState(accountId, generation, { ...this.state, appearance });
    if (!this.isCurrentRequest(request)) {
      return false;
    }
    this.pets.applyCloudAppearance(accountId, appearance);
    return true;
  }

  private isCurrentRequest(request: PetWorldAccountRequest): boolean {
    return (
      request.generation === this.generation &&
      request.accountId === this.accountId &&
      !request.signal.aborted &&
      request.isTrusted()
    );
  }

  private async saveLocalState(
    accountId: string,
    generation: number,
    state: PetWorldLocalState,
  ): Promise<void> {
    await this.store.saveState(accountId, state);
    if (accountId === this.accountId && generation === this.generation) {
      this.state = state;
    }
  }
}
