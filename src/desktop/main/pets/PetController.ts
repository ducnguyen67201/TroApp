import {
  createPetPreferences,
  PetAction,
  PetFailure,
  PetReaction,
  type PetCommand,
  type PetPlacement,
  type PetPreferences,
  type PetReply,
  type PetSnapshot,
} from '#contracts/Pet.js';

export interface PetStore {
  readPreferences(accountId: string): Promise<PetPreferences>;
  savePreferences(accountId: string, preferences: PetPreferences): Promise<void>;
}

export interface PetPresentation {
  showPet(snapshot: PetSnapshot): void;
  hidePet(): void;
}

export interface PetClock {
  schedule(callback: () => void, delayMs: number): () => void;
}

const PetTiming = { REACTION_MS: 800, ENCOURAGEMENT_MS: 600_000, BUBBLE_MS: 5_000 } as const;

/** Owns local pet state. Account epochs fence disk reads, saves and queued commands. */
export class PetController {
  private accountId: string | null = null;
  private generation = 0;
  private ready: Promise<void> = Promise.resolve();
  private pendingCommand: Promise<unknown> = Promise.resolve();
  private cancelReaction: (() => void) | null = null;
  private cancelEncouragement: (() => void) | null = null;
  private suspended = false;
  private snapshot: PetSnapshot = {
    revision: 0,
    preferences: createPetPreferences(),
    reaction: PetReaction.IDLE,
    isVisible: false,
    hasPresentationError: false,
    encouragement: false,
  };

  constructor(
    private readonly store: PetStore,
    private readonly presentation: PetPresentation,
    private readonly clock: PetClock,
    private readonly emit: (snapshot: PetSnapshot) => void,
  ) {}

  async setAccount(accountId: string | null): Promise<void> {
    if (this.accountId === accountId) {
      await this.ready;
      return;
    }
    this.generation += 1;
    const generation = this.generation;
    this.accountId = accountId;
    this.suspended = false;
    this.clearTimers();
    this.snapshot = {
      ...this.snapshot,
      preferences: createPetPreferences(),
      isVisible: false,
      reaction: PetReaction.IDLE,
      hasPresentationError: false,
      encouragement: false,
    };
    this.publish();
    this.ready = accountId ? this.loadAccount(accountId, generation) : Promise.resolve();
    await this.ready;
  }

  readSnapshot(): PetSnapshot {
    return structuredClone(this.snapshot);
  }

  executeCommand(command: PetCommand): Promise<PetReply> {
    const generation = this.generation;
    const result = this.pendingCommand.then(async (): Promise<PetReply> => {
      await this.ready;
      if (!this.accountId || generation !== this.generation) {
        return { kind: 'failed', reason: PetFailure.UNAVAILABLE };
      }
      if (command.kind === PetAction.REACT) {
        this.reactToPet(command.reaction);
        return { kind: 'ok', snapshot: this.readSnapshot() };
      }
      let preferences = this.snapshot.preferences;
      switch (command.kind) {
        case PetAction.ADOPT:
          preferences = {
            ...preferences,
            enabled: true,
            activePetId: command.petId,
            locale: command.locale,
            names: { ...preferences.names, [command.petId]: command.name },
          };
          break;
        case PetAction.PREFERENCES:
          preferences = {
            ...preferences,
            quiet: command.quiet,
            motion: command.motion,
            locale: command.locale,
          };
          break;
        case PetAction.HIDE:
          preferences = { ...preferences, enabled: false };
          break;
      }
      return this.savePreferences(preferences, generation);
    });
    this.pendingCommand = result.catch(() => {});
    return result;
  }

  savePlacement(placement: PetPlacement): Promise<PetReply> {
    const generation = this.generation;
    const result = this.pendingCommand.then(() =>
      this.savePreferences({ ...this.snapshot.preferences, placement }, generation),
    );
    this.pendingCommand = result.catch(() => {});
    return result;
  }

  reactToPet(reaction: PetSnapshot['reaction']): void {
    if (!this.snapshot.isVisible) {
      return;
    }
    this.cancelReaction?.();
    this.snapshot = { ...this.snapshot, reaction };
    this.publish();
    this.cancelReaction = this.clock.schedule(() => {
      this.cancelReaction = null;
      this.snapshot = { ...this.snapshot, reaction: PetReaction.IDLE };
      this.publish();
    }, PetTiming.REACTION_MS);
  }

  /** Used during agent work/capture so pet motion cannot obstruct teaching. */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) {
      return;
    }
    this.suspended = suspended;
    this.refreshVisibility();
  }

  markPresentationFailed(): void {
    this.snapshot = { ...this.snapshot, hasPresentationError: true };
    this.refreshVisibility();
  }

  dispose(): void {
    this.generation += 1;
    this.accountId = null;
    this.ready = Promise.resolve();
    this.clearTimers();
    this.snapshot = { ...this.snapshot, isVisible: false, encouragement: false };
    this.publish();
  }

  private async loadAccount(accountId: string, generation: number): Promise<void> {
    const preferences = await this.store.readPreferences(accountId);
    if (generation !== this.generation) {
      return;
    }
    this.snapshot = { ...this.snapshot, preferences };
    this.refreshVisibility();
  }

  private async savePreferences(
    preferences: PetPreferences,
    generation: number,
  ): Promise<PetReply> {
    const accountId = this.accountId;
    if (!accountId || generation !== this.generation) {
      return { kind: 'failed', reason: PetFailure.UNAVAILABLE };
    }
    try {
      await this.store.savePreferences(accountId, preferences);
    } catch {
      console.warn('pet.preferences.failed', { stage: 'save' });
      return { kind: 'failed', reason: PetFailure.SAVE };
    }
    if (generation !== this.generation) {
      return { kind: 'failed', reason: PetFailure.UNAVAILABLE };
    }
    this.snapshot = { ...this.snapshot, preferences, hasPresentationError: false };
    this.refreshVisibility();
    return { kind: 'ok', snapshot: this.readSnapshot() };
  }

  private refreshVisibility(): void {
    this.clearTimers();
    this.snapshot = {
      ...this.snapshot,
      reaction: PetReaction.IDLE,
      encouragement: false,
      isVisible:
        Boolean(this.accountId) &&
        this.snapshot.preferences.enabled &&
        !this.suspended &&
        !this.snapshot.hasPresentationError,
    };
    this.publish();
    this.scheduleEncouragement();
  }

  private scheduleEncouragement(): void {
    if (!this.snapshot.isVisible || this.snapshot.preferences.quiet) {
      return;
    }
    this.cancelEncouragement = this.clock.schedule(() => {
      this.snapshot = { ...this.snapshot, encouragement: true };
      this.publish();
      this.cancelEncouragement = this.clock.schedule(() => {
        this.snapshot = { ...this.snapshot, encouragement: false };
        this.publish();
        this.scheduleEncouragement();
      }, PetTiming.BUBBLE_MS);
    }, PetTiming.ENCOURAGEMENT_MS);
  }

  private clearTimers(): void {
    this.cancelReaction?.();
    this.cancelEncouragement?.();
    this.cancelReaction = null;
    this.cancelEncouragement = null;
  }

  private publish(): void {
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    const snapshot = this.readSnapshot();
    if (snapshot.isVisible) {
      this.presentation.showPet(snapshot);
    } else {
      this.presentation.hidePet();
    }
    this.emit(snapshot);
  }
}
