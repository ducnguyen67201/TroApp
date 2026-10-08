import {
  CompanionHudCommandKind,
  CompanionHudCommandSchema,
  CompanionHudPhase,
  type CompanionHudAck,
  type CompanionHudCommand,
  type CompanionHudSnapshot,
  type CompanionRenderToken,
} from '#contracts/CompanionHud.js';
import type { CompanionHudMessage } from '#contracts/CompanionHudWorker.js';
import type { TeachingMessage } from '#contracts/TeachingStep.js';

type AppearanceIntent = Omit<
  Extract<CompanionHudCommand, { kind: 'update_appearance' }>,
  'group' | 'sequence'
>;
type MessageIntent = Omit<
  Extract<CompanionHudCommand, { kind: 'present_message' }>,
  'group' | 'sequence'
>;
type ClearIntent = {
  kind: typeof CompanionHudCommandKind.CLEAR_MESSAGE;
  message: TeachingMessage;
  token: CompanionRenderToken | null;
};
type PublishIntent =
  | AppearanceIntent
  | MessageIntent
  | ClearIntent
  | { kind: typeof CompanionHudCommandKind.RENEW_LEASE };

export interface CompanionHudTransport {
  sendCommand(command: CompanionHudCommand): Promise<CompanionHudAck>;
}

function hasSameMessage(first: TeachingMessage | null, second: TeachingMessage): boolean {
  return (
    first?.lessonId === second.lessonId &&
    first.stepId === second.stepId &&
    first.sequence === second.sequence &&
    first.kind === second.kind &&
    first.text === second.text
  );
}

/** Single writer for native host commands. Lease renewal has no cached message payload.
 * Message/clear intents retain ordering; only appearance and renewal intents coalesce. */
export class CompanionHudPublisher {
  private intents: PublishIntent[] = [];
  private sequence = 1;
  private sending: Promise<void> | null = null;
  private stopped = false;
  private requested: TeachingMessage | null = null;
  private observed: CompanionHudMessage = { message: null };
  private observationRevision = 0;
  private watermark: TeachingMessage | null = null;

  constructor(
    private readonly group: string,
    private readonly transport: CompanionHudTransport,
  ) {}

  updateSnapshot(snapshot: CompanionHudSnapshot): void {
    if (this.stopped) {
      return;
    }
    const message = snapshot.message;
    if (message) {
      const previous = this.watermark;
      const stale =
        previous?.lessonId === message.lessonId && message.sequence <= previous.sequence;
      if (!stale && !hasSameMessage(this.requested, message)) {
        this.requested = message;
        this.watermark = message;
        this.enqueueOrdered({
          kind: CompanionHudCommandKind.PRESENT_MESSAGE,
          locale: snapshot.locale,
          message,
        });
      }
    } else if (message === null || snapshot.phase === CompanionHudPhase.IDLE) {
      const expected = this.requested ?? this.observed.message;
      if (expected) {
        const token = hasSameMessage(this.observed.message, expected)
          ? (this.observed.renderToken ?? null)
          : null;
        this.enqueueOrdered({
          kind: CompanionHudCommandKind.CLEAR_MESSAGE,
          message: expected,
          token,
        });
        this.requested = null;
      }
    }
    this.enqueueCoalesced({
      kind: CompanionHudCommandKind.UPDATE_APPEARANCE,
      phase: snapshot.phase,
      locale: snapshot.locale,
      level: snapshot.level,
      speakingSequence: snapshot.speakingSequence ?? null,
    });
  }

  renewLease(): void {
    if (!this.stopped) {
      this.enqueueCoalesced({ kind: CompanionHudCommandKind.RENEW_LEASE });
    }
  }

  /** Readback may advance message knowledge, but an old poll cannot replace a newer token. */
  readObservationRevision(): number {
    return this.observationRevision;
  }

  observeMessage(
    observed: CompanionHudMessage,
    expectedRevision = this.observationRevision,
  ): boolean {
    if (expectedRevision !== this.observationRevision) {
      return false;
    }
    const incoming = observed.renderToken;
    const current = this.observed.renderToken;
    if (
      incoming &&
      current &&
      incoming.ownerEpoch === current.ownerEpoch &&
      incoming.revision < current.revision
    ) {
      return false;
    }
    this.observed = observed;
    this.observationRevision += 1;
    const message = observed.message;
    if (
      message &&
      (!this.watermark ||
        message.lessonId !== this.watermark.lessonId ||
        message.sequence > this.watermark.sequence)
    ) {
      this.watermark = message;
    }
    return true;
  }

  private enqueueCoalesced(
    intent: AppearanceIntent | { kind: typeof CompanionHudCommandKind.RENEW_LEASE },
  ): void {
    this.intents = this.intents.filter((pending) => pending.kind !== intent.kind);
    this.enqueueOrdered(intent);
  }

  private enqueueOrdered(intent: PublishIntent): void {
    if (this.intents.length >= 64) {
      throw new Error('Native presentation queue exceeded its bound.');
    }
    this.intents.push(intent);
  }

  /** All callers share the same in-flight drain; new revisions are read after each acknowledgment. */
  flush(): Promise<void> {
    if (this.sending) {
      return this.sending.then(() => (this.intents.length > 0 ? this.flush() : undefined));
    }
    this.sending = this.sendQueuedCommands().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async sendQueuedCommands(): Promise<void> {
    while (!this.stopped) {
      const intent = this.intents.shift();
      if (!intent) {
        return;
      }
      let command: CompanionHudCommand;
      if (!Number.isSafeInteger(this.sequence)) {
        throw new Error('Native presentation sequence exhausted.');
      }
      if (intent.kind === CompanionHudCommandKind.CLEAR_MESSAGE) {
        const token =
          intent.token ??
          (hasSameMessage(this.observed.message, intent.message)
            ? this.observed.renderToken
            : undefined);
        if (!token) {
          continue;
        }
        command = CompanionHudCommandSchema.parse({
          kind: intent.kind,
          expectedToken: token,
          group: this.group,
          sequence: this.sequence++,
        });
      } else {
        command = CompanionHudCommandSchema.parse({
          ...intent,
          group: this.group,
          sequence: this.sequence++,
        });
      }
      const acknowledgment = await this.transport.sendCommand(command);
      if (!acknowledgment.applied) {
        throw new Error('Native presentation unavailable.');
      }
      if (command.kind === CompanionHudCommandKind.PRESENT_MESSAGE && acknowledgment.renderToken) {
        this.observeMessage({ message: command.message, renderToken: acknowledgment.renderToken });
      }
      if (
        command.kind === CompanionHudCommandKind.CLEAR_MESSAGE &&
        this.observed.renderToken?.renderId === command.expectedToken.renderId
      ) {
        this.observed = { message: null };
        this.observationRevision += 1;
      }
    }
  }

  dispose(): void {
    this.stopped = true;
    this.intents = [];
  }
}
