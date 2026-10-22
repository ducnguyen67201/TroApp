import {
  ContextFailure,
  ContextLimits,
  type ContextCommand,
  type ContextEvent,
  type ContextPreference,
  type ContextReply,
} from '#contracts/StudyContext.js';
import type { DesktopContextCommand } from '#contracts/DesktopContext.js';
import type { ContextApiClient } from './ContextApiClient.js';
import type { ContextOutbox } from './ContextOutbox.js';
import type { ContextPreferences } from './ContextPreferences.js';
import { compactContextEvents } from './CompactContextEvents.js';
import { selectSessionQuestionContext } from '../../context/SelectQuestionContext.js';
import { createHash, randomUUID } from 'node:crypto';

/** Each logical Ask refreshes references to deduplicated server sources. Reusing
 * an old event ID would let those sources fall out of the server's recent packet. */
function createQuestionReference(event: ContextEvent, questionId: string): ContextEvent {
  const digest = createHash('sha256')
    .update(questionId)
    .update('\n')
    .update(event.id)
    .digest('hex');
  return {
    ...event,
    id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  };
}

export interface ContextCollector {
  start(receive: (events: ContextEvent[]) => void): Promise<void>;
  stop(flush?: boolean): Promise<void>;
}

interface ContextUploadSnapshot {
  createdAt: number;
  events: ContextEvent[];
  entryNames: string[];
  memoryIds: Set<string>;
  capturedEvents: number;
  omittedSegments: number;
  generation: number;
}

/** One context boundary owns preferences, account fences, collector lifetime and task enrichment. */
export class DesktopContextController {
  private ownerId: string | null = null;
  private preference: ContextPreference | null = null;
  private generation = 0;
  private abort = new AbortController();
  private paused = false;
  private suspended = false;
  private writes: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private memoryEvents: ContextEvent[] = [];
  private memoryBytes = 0;
  private pendingUpload: ContextUploadSnapshot | null = null;
  private retrievalCoverage: string | null = null;

  constructor(
    private readonly api: Pick<ContextApiClient, 'execute'>,
    private readonly collector: ContextCollector,
    private readonly cancelTask: () => void,
    private readonly outbox?: Pick<
      ContextOutbox,
      'save' | 'readPending' | 'acknowledge' | 'forget'
    > &
      Partial<Pick<ContextOutbox, 'readSession'>>,
    private readonly preferences?: ContextPreferences,
  ) {}

  readScope(): ContextPreference | null {
    return this.preference?.enabled ? this.preference : null;
  }

  async setAccount(ownerId: string | null): Promise<void> {
    if (this.ownerId === ownerId) {
      return;
    }
    this.clear();
    this.ownerId = ownerId;
    if (!ownerId) {
      return;
    }
    const generation = this.generation;
    const local = await this.preferences?.read(ownerId);
    const result = await this.api.execute({ kind: 'preferences' }, this.abort.signal);
    console.info('context.account.resolved', {
      reply: result.kind,
      code: result.kind === 'failed' ? result.code : undefined,
      enabled: result.kind === 'preferences' ? result.preference.enabled : false,
      localOptOut: local === false,
    });
    if (generation === this.generation && result.kind === 'preferences') {
      this.preference = {
        ...result.preference,
        enabled: local !== false && result.preference.enabled,
      };
      await this.resume();
    }
  }

  clear(): void {
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.preference = null;
    this.ownerId = null;
    this.paused = false;
    this.memoryEvents = [];
    this.memoryBytes = 0;
    this.pendingUpload = null;
    this.retrievalCoverage = null;
    void this.collector.stop();
  }

  async control(command: DesktopContextCommand): Promise<ContextReply> {
    if (!this.ownerId) {
      return { kind: 'failed', code: ContextFailure.UNAUTHORIZED };
    }
    const ownerId = this.ownerId;
    if (command.kind === 'preferences' && this.preference) {
      return { kind: 'preferences', preference: this.preference };
    }
    if (command.kind === 'set-enabled' && !command.enabled) {
      const wasEnabled = this.preference?.enabled ?? false;
      this.generation += 1;
      this.abort.abort();
      this.abort = new AbortController();
      if (this.preference) {
        this.preference = { ...this.preference, enabled: false };
      }
      this.memoryEvents = [];
      this.memoryBytes = 0;
      this.pendingUpload = null;
      this.retrievalCoverage = null;
      if (wasEnabled) {
        this.cancelTask();
      }
      await this.collector.stop();
      await this.preferences?.save(this.ownerId, false).catch(() => {
        console.warn('context.preference.failed', { stage: 'disable' });
      });
    }
    const scope = this.preference;
    if (
      (command.kind === 'forget' || command.kind === 'inspect' || command.kind === 'correct') &&
      !scope
    ) {
      return { kind: 'failed', code: ContextFailure.UNAVAILABLE };
    }
    if (command.kind === 'forget') {
      this.generation += 1;
      this.abort.abort();
      this.abort = new AbortController();
      this.cancelTask();
      await this.collector.stop();
      await this.writes;
      this.memoryEvents = [];
      this.memoryBytes = 0;
      this.pendingUpload = null;
      this.retrievalCoverage = null;
      await this.outbox?.forget(ownerId);
    }
    if (ownerId !== this.ownerId) {
      return { kind: 'failed', code: ContextFailure.STALE };
    }
    const generation = this.generation;
    const request: ContextCommand =
      command.kind === 'forget' || command.kind === 'inspect' || command.kind === 'correct'
        ? { ...command, generation: scope?.generation ?? 0 }
        : command.kind === 'set-enabled'
          ? { ...command, expectedGeneration: scope?.generation ?? 0 }
          : command;
    const reply = await this.api.execute(request, this.abort.signal);
    if (generation !== this.generation || ownerId !== this.ownerId) {
      return { kind: 'failed', code: ContextFailure.STALE };
    }
    if (reply.kind === 'preferences') {
      this.preference = reply.preference;
      if (command.kind === 'set-enabled') {
        await this.preferences?.save(ownerId, command.enabled);
      }
      await this.resume();
    }
    return reply;
  }

  async execute(command: ContextCommand): Promise<ContextReply> {
    const scope = this.readScope();
    if (
      !scope ||
      !('generation' in command) ||
      command.generation !== scope.generation ||
      command.kind === 'forget' ||
      command.kind === 'inspect' ||
      command.kind === 'correct'
    ) {
      return { kind: 'failed', code: ContextFailure.DISABLED };
    }
    const generation = this.generation;
    const result = await this.api.execute(command, this.abort.signal);
    if (
      result.kind === 'failed' &&
      (result.code === ContextFailure.DISABLED || result.code === ContextFailure.STALE) &&
      generation === this.generation
    ) {
      if (this.preference) {
        this.preference = { ...this.preference, enabled: false };
      }
      this.cancelTask();
      void this.collector.stop();
    }
    if (generation !== this.generation || this.readScope()?.generation !== scope.generation) {
      return { kind: 'failed', code: ContextFailure.STALE };
    }
    if (result.kind === 'packet' && this.retrievalCoverage) {
      return {
        kind: 'packet',
        packet: {
          ...result.packet,
          gaps: [this.retrievalCoverage, ...result.packet.gaps].slice(0, 12),
        },
      };
    }
    return result;
  }

  /** Ask boundary: finish local writes, ingest one compact snapshot, then admit the agent. */
  async pause(question?: string): Promise<void> {
    const ownerId = this.ownerId;
    const generation = this.generation;
    await this.collector.stop(true);
    if (ownerId !== this.ownerId || generation !== this.generation) {
      return;
    }
    this.paused = true;
    await this.writes;
    if (ownerId !== this.ownerId || generation !== this.generation) {
      return;
    }
    if (question !== undefined) {
      await this.ingestQuestionContext(question);
    } else {
      await this.ingestLocalContext();
    }
  }

  async resume(): Promise<void> {
    this.paused = false;
    if (this.readScope() && !this.suspended) {
      await this.collector
        .start((events) => {
          this.queueEvents(events);
        })
        .catch(() => {
          console.warn('context.collector.failed', { stage: 'start' });
        });
    }
  }

  async suspend(): Promise<void> {
    this.suspended = true;
    await this.collector.stop();
  }

  async wake(): Promise<void> {
    this.suspended = false;
    if (!this.paused) {
      await this.resume();
    }
  }

  private queueEvents(events: ContextEvent[]): void {
    const ownerId = this.ownerId;
    const scope = this.readScope();
    const generation = this.generation;
    if (!ownerId || !scope || this.paused || this.suspended) {
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(events));
    if (this.queuedBytes + bytes > 16 * 1024 * 1024) {
      console.warn('context.events.failed', { stage: 'queue_full', coverage: 'gap' });
      return;
    }
    this.queuedBytes += bytes;
    this.writes = this.writes
      .then(async () => {
        if (generation !== this.generation || !this.readScope()) {
          return;
        }
        try {
          if (this.outbox) {
            await this.outbox.save(ownerId, scope.generation, events);
            return;
          }
        } catch {
          console.warn('context.outbox.failed', { stage: 'save', coverage: 'memory-only' });
        }
        if (generation !== this.generation || ownerId !== this.ownerId || !this.readScope()) {
          return;
        }
        if (this.memoryBytes + bytes <= 16 * 1024 * 1024) {
          this.memoryEvents.push(...events);
          this.memoryBytes += bytes;
        } else {
          console.warn('context.events.failed', { stage: 'memory_full', coverage: 'gap' });
        }
      })
      .catch(() => {
        console.warn('context.events.failed', { stage: 'queue' });
      })
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }

  /** Search retained local evidence for this Ask. Upload receipts describe earlier
   * projections; they must not hide an assignment from a later, different question. */
  private async ingestQuestionContext(question: string): Promise<void> {
    const ownerId = this.ownerId;
    const scope = this.readScope();
    const generation = this.generation;
    if (!ownerId || !scope) {
      return;
    }
    const startedAt = performance.now();
    this.retrievalCoverage = null;
    try {
      const earliestRetained = Date.now() - ContextLimits.SESSION_MS;
      this.memoryEvents = this.memoryEvents.filter(
        (event) => Date.parse(event.observedAt) >= earliestRetained,
      );
      this.memoryBytes = Buffer.byteLength(JSON.stringify(this.memoryEvents));
      const session = await this.outbox?.readSession?.(ownerId, scope.generation).catch(() => {
        console.warn('context.outbox.failed', {
          stage: 'question-session-read',
          coverage: 'memory-only',
        });
        return undefined;
      });
      if (generation !== this.generation || ownerId !== this.ownerId || !this.readScope()) {
        return;
      }
      const selection = await selectSessionQuestionContext(
        [...(session?.events ?? []), ...this.memoryEvents],
        question,
      );
      if (generation !== this.generation || ownerId !== this.ownerId || !this.readScope()) {
        return;
      }
      const partial = session?.partial ?? true;
      this.retrievalCoverage = `Local question retrieval: ${String(selection.coverage.eligibleEvents)} eligible evidence records, ${String(selection.events.length)} selected excerpts, ${String(selection.coverage.omittedEvents)} omitted records. Session read ${partial ? 'partial; additional local evidence was not examined' : 'completed within configured bounds'}. Selected text is sampled evidence, not a complete activity replay.`;
      if (!selection.events.length) {
        return;
      }
      const questionId = randomUUID();
      const reply = await this.execute({
        kind: 'events',
        generation: scope.generation,
        events: selection.events.map((event) => createQuestionReference(event, questionId)),
      });
      if (generation !== this.generation || ownerId !== this.ownerId || !this.readScope()) {
        return;
      }
      if (reply.kind !== 'accepted') {
        this.retrievalCoverage =
          'Question-relevant local evidence was selected but ingestion was rejected. The packet may contain earlier accepted evidence; do not assume the new local selection is present.';
        console.warn('context.events.rejected', {
          count: selection.events.length,
          reply: reply.kind,
          code: reply.kind === 'failed' ? reply.code : undefined,
        });
        return;
      }
      /* A request retry keeps its exact references. A later Ask refreshes references
         while source text remains deduplicated. Originals are never acknowledged away. */
      console.info('context.question.ingested', {
        scannedEntries: session?.scannedEntries ?? 0,
        candidateEvents: selection.coverage.eligibleEvents,
        selectedEvents: selection.events.length,
        selectedCharacters: selection.coverage.selectedCharacters,
        omittedEvents: selection.coverage.omittedEvents,
        partial,
        cacheHit: session?.cacheHit ?? false,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch {
      if (generation === this.generation && ownerId === this.ownerId) {
        this.retrievalCoverage =
          'Local question retrieval or ingestion failed. The packet may contain only earlier accepted evidence; do not infer missing assignments or errors.';
      }
      console.warn('context.outbox.failed', { stage: 'question-retrieval', coverage: 'gap' });
    }
  }

  private async ingestLocalContext(): Promise<void> {
    const ownerId = this.ownerId;
    const scope = this.readScope();
    const generation = this.generation;
    if (!ownerId || !scope) {
      return;
    }
    try {
      const earliestRetained = Date.now() - ContextLimits.RETENTION_MS;
      this.memoryEvents = this.memoryEvents.filter(
        (event) => Date.parse(event.observedAt) >= earliestRetained,
      );
      this.memoryBytes = Buffer.byteLength(JSON.stringify(this.memoryEvents));
      if (this.pendingUpload && this.pendingUpload.createdAt < earliestRetained) {
        this.pendingUpload = null;
      }
      if (!this.pendingUpload || this.pendingUpload.generation !== scope.generation) {
        const snapshot = await this.outbox?.readPending(ownerId, scope.generation).catch(() => {
          console.warn('context.outbox.failed', { stage: 'read', coverage: 'memory-only' });
          return undefined;
        });
        if (generation !== this.generation || ownerId !== this.ownerId || !this.readScope()) {
          return;
        }
        /* Never mix durable and transient records in a retry payload: transient memory
           disappears at restart while the encrypted disk manifest survives. */
        const diskEvents = snapshot?.entries.flatMap((entry) => entry.events) ?? [];
        const memoryEvents = diskEvents.length ? [] : [...this.memoryEvents];
        const captured = [...diskEvents, ...memoryEvents];
        const events = compactContextEvents(captured, snapshot?.omittedEntries ?? 0);
        if (!events.length) {
          return;
        }
        this.pendingUpload = {
          createdAt: Date.now(),
          events,
          entryNames: snapshot?.entries.map((entry) => entry.name) ?? [],
          memoryIds: new Set(memoryEvents.map((event) => event.id)),
          capturedEvents: captured.length,
          omittedSegments: snapshot?.omittedEntries ?? 0,
          generation: scope.generation,
        };
      }
      const upload = this.pendingUpload;
      const reply = await this.execute({
        kind: 'events',
        generation: scope.generation,
        events: upload.events,
      });
      if (reply.kind !== 'accepted') {
        console.warn('context.events.rejected', {
          count: upload.events.length,
          reply: reply.kind,
          code: reply.kind === 'failed' ? reply.code : undefined,
        });
        return;
      }
      if (generation !== this.generation || ownerId !== this.ownerId || !this.readScope()) {
        return;
      }
      await this.outbox?.acknowledge(upload.entryNames);
      if (
        generation !== this.generation ||
        ownerId !== this.ownerId ||
        this.pendingUpload !== upload
      ) {
        return;
      }
      this.memoryEvents = this.memoryEvents.filter((event) => !upload.memoryIds.has(event.id));
      this.memoryBytes = Buffer.byteLength(JSON.stringify(this.memoryEvents));
      this.pendingUpload = null;
      console.info('context.snapshot.ingested', {
        capturedEvents: upload.capturedEvents,
        uploadedEvents: upload.events.length,
        omittedSegments: upload.omittedSegments,
      });
    } catch {
      console.warn('context.outbox.failed', { stage: 'ask-ingestion' });
    }
  }
}
