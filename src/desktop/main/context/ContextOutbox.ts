import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, lstat, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { z } from 'zod';
import {
  ContextEventKind,
  ContextEventSchema,
  ContextLimits,
  type ContextEvent,
} from '#contracts/StudyContext.js';
import {
  appendJournalFrame,
  readJournalFrame,
  readNewestJournalFrames,
  ContextJournalFileLimits,
  type ContextJournalFrameRange,
} from './ContextJournalFile.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const formatHeader = Buffer.from('TROCTX\x01', 'binary');
const maximumPendingEntries = 64;
const maximumPendingBytes = 4 * 1024 * 1024;
const maximumDecodeAttempts = maximumPendingEntries * 2;
const nonceBytes = 12;
const authenticationBytes = 16;

/** Local scan bounds apply before question selection, independently of model tokens. */
export const ContextSessionReadLimits = {
  MAXIMUM_DECODED_BYTES: 50 * 1024 * 1024,
  MAXIMUM_FRAMES: 16_384,
  PAGE_FRAMES: 64,
} as const;
const legacyReferencePattern =
  /^[a-f0-9]{64}-(?:(\d+)-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(\.sent)?\.bin$/u;
const journalPattern = /^[a-f0-9]{64}-(\d+)-(\d{8}T\d{2})(?:-Migrated)?\.journal$/u;
const journalReferencePattern =
  /^([a-f0-9]{64}-\d+-\d{8}T\d{2}(?:-Migrated)?\.journal)~(\d+)-(\d+)$/u;
const RangeSchema = z
  .strictObject({
    start: z.number().int().min(ContextJournalFileLimits.HEADER_BYTES),
    end: z.number().int().max(ContextLimits.OUTBOX_BYTES),
  })
  .refine((range) => range.end > range.start);
const ReceiptSchema = z.strictObject({
  ranges: z.array(RangeSchema).max(ContextJournalFileLimits.MAXIMUM_READ_FRAMES),
});

function parseJournalReference(
  reference: string,
): (ContextJournalFrameRange & { file: string }) | null {
  const match = journalReferencePattern.exec(reference);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  const parsed = RangeSchema.safeParse({ start: Number(match[2]), end: Number(match[3]) });
  return parsed.success ? { file: match[1], ...parsed.data } : null;
}

function isValidReference(reference: string): boolean {
  return legacyReferencePattern.test(reference) || parseJournalReference(reference) !== null;
}

function isJournalMetadata(name: string): boolean {
  return name.endsWith('.ack') && journalPattern.test(name.slice(0, -'.ack'.length));
}

function isOwnedFile(name: string): boolean {
  return (
    legacyReferencePattern.test(name) ||
    journalPattern.test(name) ||
    isJournalMetadata(name) ||
    manifestPattern.test(name) ||
    migrationPattern.test(name)
  );
}

function mergeRanges(ranges: readonly ContextJournalFrameRange[]): ContextJournalFrameRange[] {
  const merged: ContextJournalFrameRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function isAcknowledged(
  range: ContextJournalFrameRange,
  receipts: readonly ContextJournalFrameRange[],
): boolean {
  return receipts.some((receipt) => receipt.start <= range.start && receipt.end >= range.end);
}

const manifestPattern = /^[a-f0-9]{64}-\d+\.upload$/u;
const migrationPattern = /^[a-f0-9]{64}-\d+\.migrate$/u;
const UploadManifestSchema = z.strictObject({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
  names: z.array(z.string().refine(isValidReference)).min(1).max(maximumPendingEntries),
  omittedEntries: z.number().int().nonnegative(),
});
type UploadManifest = z.infer<typeof UploadManifestSchema>;
const OutboxEntrySchema = z.strictObject({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
  events: z.array(ContextEventSchema).min(1).max(ContextLimits.BATCH_EVENTS),
});

const MigrationReceiptSchema = z.strictObject({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
  oldName: z.string().regex(legacyReferencePattern),
  newReference: z.string().refine((reference) => parseJournalReference(reference) !== null),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sent: z.boolean(),
});
type MigrationReceipt = z.infer<typeof MigrationReceiptSchema>;

export interface ContextConsolidationResult {
  migrated: number;
  expired: number;
  failed: number;
}

export interface PendingContextEntry {
  name: string;
  events: ContextEvent[];
}

export interface PendingContextJournal {
  entries: PendingContextEntry[];
  omittedEntries: number;
}

/** Evidence for local retrieval includes acknowledged history, without changing receipts.
 * Partial coverage means a scan bound, unreadable record or incomplete frame was encountered. */
export interface SessionContextJournal {
  events: ContextEvent[];
  scannedEntries: number;
  scannedEvents: number;
  skippedInputEvents: number;
  omittedEntries: number;
  partial: boolean;
  cacheHit: boolean;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

export interface ReadContextSessionOptions {
  /** A caller may lower the local decode budget, never exceed the fixed upper bound. */
  maximumBytes?: number;
}

interface JournalFile {
  name: string;
  bytes: number;
  modifiedAt: number;
  changedAt: number;
}

interface SessionContextBatch {
  createdAt: number;
  events: ContextEvent[];
  scannedEvents: number;
  skippedInputEvents: number;
  bytes: number;
}

interface SessionContextCache {
  ownerId: string;
  generation: number;
  maximumBytes: number;
  fingerprint: string;
  batches: SessionContextBatch[];
  decodedBytes: number;
  scannedEntries: number;
  omittedEntries: number;
  partial: boolean;
}

interface ConsolidationJournalIndex {
  references: Map<string, string>;
  modifiedAt: number;
}

interface DecodedEntry extends PendingContextEntry {
  observedAt: string;
}

function readOwnerPrefix(ownerId: string): string {
  return `${createHash('sha256').update(ownerId).digest('hex')}-`;
}

function validateReference(name: string): void {
  if (!isValidReference(name)) {
    throw new Error('Invalid outbox reference.');
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function compareChronology(left: DecodedEntry, right: DecodedEntry): number {
  return left.observedAt.localeCompare(right.observedAt) || left.name.localeCompare(right.name);
}

function readJournalHour(name: string): number | null {
  const hour = journalPattern.exec(name)?.[2];
  if (!hour) {
    return null;
  }
  const parsed = Date.parse(
    `${hour.slice(0, 4)}-${hour.slice(4, 6)}-${hour.slice(6, 8)}T${hour.slice(9, 11)}:00:00.000Z`,
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function selectSessionFiles(
  files: readonly JournalFile[],
  ownerId: string,
  generation: number,
  nowMs: number,
): JournalFile[] {
  const prefix = readOwnerPrefix(ownerId);
  const firstHour = Math.floor((nowMs - ContextLimits.SESSION_MS) / 3_600_000) * 3_600_000;
  return files
    .filter((file) => {
      if (!file.name.startsWith(prefix)) {
        return false;
      }
      const journal = journalPattern.exec(file.name);
      if (journal) {
        const hour = readJournalHour(file.name);
        return Number(journal[1]) === generation && hour !== null && hour >= firstHour;
      }
      const legacy = legacyReferencePattern.exec(file.name);
      return legacy !== null && (legacy[1] === undefined || Number(legacy[1]) === generation);
    })
    .sort(
      (left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name),
    );
}

function readSessionFingerprint(files: readonly JournalFile[]): string {
  return files
    .map((file) => JSON.stringify([file.name, file.bytes, file.modifiedAt, file.changedAt]))
    .sort()
    .join('\n');
}

function hasSameEvent(left: ContextEvent, right: ContextEvent): boolean {
  return (
    left.kind === right.kind &&
    left.resource === right.resource &&
    left.observedAt === right.observedAt &&
    left.text === right.text &&
    left.limitation === right.limitation
  );
}

function readSessionView(
  cache: SessionContextCache,
  nowMs: number,
  cacheHit: boolean,
): SessionContextJournal {
  const earliest = nowMs - ContextLimits.SESSION_MS;
  const batches = cache.batches.filter(
    (batch) => batch.createdAt >= earliest && batch.createdAt <= nowMs,
  );
  cache.batches = batches.map((batch) => ({
    ...batch,
    events: batch.events.filter((event) => {
      const observedAt = Date.parse(event.observedAt);
      return observedAt >= earliest && observedAt <= nowMs;
    }),
  }));
  cache.decodedBytes = cache.batches.reduce((bytes, batch) => bytes + batch.bytes, 0);
  const unique = new Map<string, ContextEvent>();
  const conflictingIds = new Set<string>();
  let conflictingEvents = 0;
  for (const batch of batches) {
    for (const event of batch.events) {
      const observedAt = Date.parse(event.observedAt);
      if (observedAt < earliest || observedAt > nowMs) {
        continue;
      }
      if (conflictingIds.has(event.id)) {
        conflictingEvents += 1;
        continue;
      }
      const previous = unique.get(event.id);
      if (previous && !hasSameEvent(previous, event)) {
        unique.delete(event.id);
        conflictingIds.add(event.id);
        conflictingEvents += 1;
      } else {
        unique.set(event.id, { ...event });
      }
    }
  }
  const events = [...unique.values()].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id),
  );
  return {
    events,
    scannedEntries: cache.scannedEntries,
    scannedEvents: batches.reduce((count, batch) => count + batch.scannedEvents, 0),
    skippedInputEvents: batches.reduce((count, batch) => count + batch.skippedInputEvents, 0),
    omittedEntries: cache.omittedEntries + conflictingEvents,
    partial: cache.partial || conflictingEvents > 0,
    cacheHit,
    firstObservedAt: events[0]?.observedAt ?? null,
    lastObservedAt: events.at(-1)?.observedAt ?? null,
  };
}

/** A local journal: compressed AES-GCM records stay on disk after acknowledgement
 * until retention expires. No plaintext activity or model credentials enter these files. */
export class ContextOutbox {
  private key: Promise<webcrypto.CryptoKey> | null = null;
  private operations: Promise<void> = Promise.resolve();
  /* Only the active owner/generation is retained in memory; no plaintext index file exists. */
  private sessionCache: SessionContextCache | null = null;

  constructor(
    private readonly directory: string,
    private readonly protect: (key: string) => Buffer,
    private readonly unprotect: (bytes: Buffer) => string,
  ) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private readKey(): Promise<webcrypto.CryptoKey> {
    this.key ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, 'Key');
      let raw: string;
      try {
        raw = this.unprotect(await readFile(file));
      } catch (error: unknown) {
        if (!isMissingFile(error)) {
          throw error;
        }
        raw = randomBytes(32).toString('base64');
        await writeFile(file, this.protect(raw), { mode: 0o600, flag: 'wx' });
      }
      return webcrypto.subtle.importKey('raw', Buffer.from(raw, 'base64'), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    })();
    return this.key;
  }

  /** Retention runs on every append/read, even when the student never presses Ask. */
  private async listRetainedFiles(): Promise<JournalFile[]> {
    const now = Date.now();
    const retained: JournalFile[] = [];
    for (const name of await readdir(this.directory)) {
      const unfinished = name.endsWith('.pending');
      const reference = unfinished ? name.slice(0, -'.pending'.length) : name;
      if (!isOwnedFile(reference)) {
        continue;
      }
      try {
        const metadata = await lstat(join(this.directory, name));
        if (!metadata.isFile()) {
          continue;
        }
        if (metadata.mtimeMs + ContextLimits.RETENTION_MS < now) {
          await rm(join(this.directory, name), { force: true });
        } else {
          retained.push({
            name,
            bytes: metadata.size,
            modifiedAt: metadata.mtimeMs,
            changedAt: metadata.ctimeMs,
          });
        }
      } catch (error: unknown) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
    }
    return retained;
  }

  /** Consolidate old per-batch files without changing their captured content or upload state.
   * Startup calls this before collection; the encrypted receipt makes partial migration retryable. */
  consolidateLegacyLogs(): Promise<ContextConsolidationResult> {
    return this.runExclusive(() => {
      this.sessionCache = null;
      return this.consolidateLegacyEntries();
    });
  }

  private readMigrationName(ownerId: string, generation: number): string {
    return `${readOwnerPrefix(ownerId)}${String(generation)}.migrate`;
  }

  private readJournalName(
    ownerId: string,
    generation: number,
    createdAt: number,
    migrated = false,
  ): string {
    const hour = new Date(createdAt).toISOString().slice(0, 13).replace(/[-:]/gu, '');
    return `${readOwnerPrefix(ownerId)}${String(generation)}-${hour}${migrated ? '-Migrated' : ''}.journal`;
  }

  private async consolidateLegacyEntries(): Promise<ContextConsolidationResult> {
    const result: ContextConsolidationResult = { migrated: 0, expired: 0, failed: 0 };
    const names = await readdir(this.directory).catch((error: unknown): string[] => {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    });
    if (!names.some((name) => migrationPattern.test(name) || legacyReferencePattern.test(name))) {
      return result;
    }
    const key = await this.readKey();
    const blocked = new Set<string>();
    const journalIndexes = new Map<string, ConsolidationJournalIndex>();
    for (const name of names.filter((name) => migrationPattern.test(name)).sort()) {
      try {
        const raw: unknown = JSON.parse((await this.decryptEntry(name, key)).toString('utf8'));
        const receipt = MigrationReceiptSchema.parse(raw);
        if (name !== this.readMigrationName(receipt.ownerId, receipt.generation)) {
          throw new Error('Invalid context consolidation scope.');
        }
        await this.finishConsolidation(receipt, key);
        result.migrated += 1;
      } catch {
        blocked.add(name);
        result.failed += 1;
        console.warn('context.journal.consolidation.failed', { stage: 'resume' });
      }
    }
    const remaining: { name: string; modifiedAt: number }[] = [];
    for (const name of (await readdir(this.directory)).filter((name) =>
      legacyReferencePattern.test(name),
    )) {
      try {
        const metadata = await lstat(join(this.directory, name));
        if (metadata.isFile()) {
          remaining.push({ name, modifiedAt: metadata.mtimeMs });
        }
      } catch (error: unknown) {
        if (!isMissingFile(error)) {
          result.failed += 1;
          console.warn('context.journal.consolidation.failed', { stage: 'metadata' });
        }
      }
    }
    remaining.sort(
      (left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name),
    );
    for (const { name } of remaining) {
      let scope: string | null = null;
      try {
        const { entry } = await this.readEntry(name, key);
        scope = this.readMigrationName(entry.ownerId, entry.generation);
        if (blocked.has(scope)) {
          continue;
        }
        if (!name.startsWith(readOwnerPrefix(entry.ownerId))) {
          throw new Error('Legacy context owner does not match its filename.');
        }
        const encodedGeneration = legacyReferencePattern.exec(name)?.[1];
        if (encodedGeneration !== undefined && Number(encodedGeneration) !== entry.generation) {
          throw new Error('Legacy context generation does not match its filename.');
        }
        if (entry.createdAt + ContextLimits.RETENTION_MS < Date.now()) {
          await rm(join(this.directory, name), { force: true });
          result.expired += 1;
          continue;
        }
        const payload = await readFile(join(this.directory, name));
        const newReference = await this.appendLegacyPayload(entry, payload, journalIndexes);
        const receipt: MigrationReceipt = {
          ownerId: entry.ownerId,
          generation: entry.generation,
          createdAt: Date.now(),
          oldName: name,
          newReference,
          payloadDigest: createHash('sha256').update(payload).digest('hex'),
          sent: name.endsWith('.sent.bin'),
        };
        await this.saveMetadata(scope, receipt, key);
        await this.finishConsolidation(receipt, key);
        result.migrated += 1;
      } catch {
        if (scope) {
          blocked.add(scope);
        }
        result.failed += 1;
        console.warn('context.journal.consolidation.failed', { stage: 'copy' });
      }
    }
    return result;
  }

  private async appendLegacyPayload(
    entry: z.infer<typeof OutboxEntrySchema>,
    payload: Buffer,
    indexes: Map<string, ConsolidationJournalIndex>,
  ): Promise<string> {
    const name = this.readJournalName(entry.ownerId, entry.generation, entry.createdAt, true);
    let index = indexes.get(name);
    if (!index) {
      index = { references: new Map(), modifiedAt: entry.createdAt };
      try {
        index.modifiedAt = Math.max(
          index.modifiedAt,
          (await lstat(join(this.directory, name))).mtimeMs,
        );
        let before: number | undefined;
        let inspected = 0;
        while (inspected < ContextJournalFileLimits.MAXIMUM_READ_FRAMES) {
          const page = await readNewestJournalFrames(join(this.directory, name), {
            ...(before === undefined ? {} : { before }),
            limit: Math.min(128, ContextJournalFileLimits.MAXIMUM_READ_FRAMES - inspected),
            maxBytes: maximumPendingBytes,
          });
          for (const frame of page.frames) {
            inspected += 1;
            const digest = createHash('sha256').update(frame.payload).digest('hex');
            index.references.set(digest, `${name}~${String(frame.start)}-${String(frame.end)}`);
          }
          const oldest = page.frames.at(-1);
          if (!page.omitted || !oldest) {
            break;
          }
          before = oldest.start;
        }
        if (inspected >= ContextJournalFileLimits.MAXIMUM_READ_FRAMES) {
          throw new Error('Context consolidation exceeded its frame bound.');
        }
      } catch (error: unknown) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
      indexes.set(name, index);
    }
    const digest = createHash('sha256').update(payload).digest('hex');
    const existing = index.references.get(digest);
    if (existing) {
      return existing;
    }
    const files = await this.listRetainedFiles();
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    const headerBytes = files.some((file) => file.name === name)
      ? 0
      : ContextJournalFileLimits.HEADER_BYTES;
    if (
      totalBytes +
        headerBytes +
        ContextJournalFileLimits.FRAME_OVERHEAD_BYTES +
        payload.byteLength >
      ContextLimits.OUTBOX_BYTES
    ) {
      throw new Error('Context outbox is full.');
    }
    const range = await appendJournalFrame(join(this.directory, name), payload);
    index.modifiedAt = Math.max(index.modifiedAt, entry.createdAt);
    const modifiedAt = new Date(index.modifiedAt);
    await utimes(join(this.directory, name), modifiedAt, modifiedAt);
    const reference = `${name}~${String(range.start)}-${String(range.end)}`;
    index.references.set(digest, reference);
    return reference;
  }

  private async readConsolidationManifest(
    ownerId: string,
    generation: number,
    key: webcrypto.CryptoKey,
  ): Promise<UploadManifest | null> {
    try {
      const raw: unknown = JSON.parse(
        (await this.decryptEntry(this.readManifestName(ownerId, generation), key)).toString('utf8'),
      );
      const manifest = UploadManifestSchema.parse(raw);
      if (
        manifest.ownerId !== ownerId ||
        manifest.generation !== generation ||
        manifest.names.some((reference) => !reference.startsWith(readOwnerPrefix(ownerId)))
      ) {
        throw new Error('Invalid frozen context manifest during consolidation.');
      }
      return manifest;
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return null;
      }
      throw new Error('Frozen context manifest cannot be consolidated.', { cause: error });
    }
  }

  private async finishConsolidation(
    receipt: MigrationReceipt,
    key: webcrypto.CryptoKey,
  ): Promise<void> {
    const reference = parseJournalReference(receipt.newReference);
    if (
      !reference ||
      !receipt.oldName.startsWith(readOwnerPrefix(receipt.ownerId)) ||
      receipt.sent !== receipt.oldName.endsWith('.sent.bin')
    ) {
      throw new Error('Invalid context consolidation receipt.');
    }
    const payload = await readJournalFrame(
      join(this.directory, reference.file),
      reference.start,
      reference.end,
    );
    if (createHash('sha256').update(payload).digest('hex') !== receipt.payloadDigest) {
      throw new Error('Consolidated context bytes do not match the source.');
    }
    const { entry } = await this.readEntry(receipt.newReference, key);
    if (
      entry.ownerId !== receipt.ownerId ||
      entry.generation !== receipt.generation ||
      reference.file !==
        this.readJournalName(entry.ownerId, entry.generation, entry.createdAt, true)
    ) {
      throw new Error('Consolidated context scope does not match the source.');
    }
    try {
      const source = await readFile(join(this.directory, receipt.oldName));
      if (createHash('sha256').update(source).digest('hex') !== receipt.payloadDigest) {
        throw new Error('Legacy context changed before consolidation completed.');
      }
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
    if (receipt.sent) {
      await this.acknowledgeEntries([receipt.newReference]);
    }
    const manifest = await this.readConsolidationManifest(receipt.ownerId, receipt.generation, key);
    if (manifest) {
      const canonicalName = receipt.oldName.replace(/\.sent\.bin$/u, '.bin');
      const names = manifest.names.map((name) =>
        name === receipt.oldName || name === canonicalName ? receipt.newReference : name,
      );
      if (names.some((name, index) => name !== manifest.names[index])) {
        await this.saveMetadata(
          this.readManifestName(receipt.ownerId, receipt.generation),
          { ...manifest, names },
          key,
        );
      }
    }
    await rm(join(this.directory, receipt.oldName), { force: true });
    await rm(join(this.directory, this.readMigrationName(receipt.ownerId, receipt.generation)), {
      force: true,
    });
  }

  save(ownerId: string, generation: number, events: ContextEvent[]): Promise<string> {
    return this.runExclusive(() => this.appendEvents(ownerId, generation, events));
  }

  /** Append independently encrypted records; hourly rotation keeps file count and recovery bounded. */
  private async appendEvents(
    ownerId: string,
    generation: number,
    events: ContextEvent[],
  ): Promise<string> {
    const key = await this.readKey();
    const createdAt = Date.now();
    const validated = OutboxEntrySchema.parse({ ownerId, generation, events, createdAt });
    const entry = Buffer.from(JSON.stringify(validated));
    if (entry.byteLength > ContextLimits.EVENT_BYTES) {
      throw new Error('Context outbox entry is oversized.');
    }
    const payload = await this.encryptEntry(entry, key);
    const files = await this.listRetainedFiles();
    const name = this.readJournalName(ownerId, generation, createdAt);
    const bytes = files.reduce((total, file) => total + file.bytes, 0);
    const headerBytes = files.some((file) => file.name === name)
      ? 0
      : ContextJournalFileLimits.HEADER_BYTES;
    if (
      bytes + headerBytes + ContextJournalFileLimits.FRAME_OVERHEAD_BYTES + payload.byteLength >
      ContextLimits.OUTBOX_BYTES
    ) {
      throw new Error('Context outbox is full.');
    }
    const range = await appendJournalFrame(join(this.directory, name), payload);
    await this.appendSessionCache(validated, entry.byteLength, name, files);
    return `${name}~${String(range.start)}-${String(range.end)}`;
  }

  private async appendSessionCache(
    entry: z.infer<typeof OutboxEntrySchema>,
    bytes: number,
    name: string,
    filesBeforeAppend: readonly JournalFile[],
  ): Promise<void> {
    const cache = this.sessionCache;
    if (!cache) {
      return;
    }
    const scopeMatches = cache.ownerId === entry.ownerId && cache.generation === entry.generation;
    const files = selectSessionFiles(
      filesBeforeAppend,
      entry.ownerId,
      entry.generation,
      entry.createdAt,
    );
    if (
      !scopeMatches ||
      cache.partial ||
      readSessionFingerprint(files) !== cache.fingerprint ||
      cache.decodedBytes + bytes > cache.maximumBytes ||
      cache.scannedEntries >= ContextSessionReadLimits.MAXIMUM_FRAMES
    ) {
      this.sessionCache = null;
      return;
    }
    try {
      const metadata = await lstat(join(this.directory, name));
      if (!metadata.isFile()) {
        this.sessionCache = null;
        return;
      }
      const updated = files.filter((file) => file.name !== name);
      updated.push({
        name,
        bytes: metadata.size,
        modifiedAt: metadata.mtimeMs,
        changedAt: metadata.ctimeMs,
      });
      cache.fingerprint = readSessionFingerprint(updated);
      cache.batches.push(this.createSessionBatch(entry, bytes));
      cache.decodedBytes += bytes;
      cache.scannedEntries += 1;
    } catch {
      /* A cache failure must not turn a successfully durable append into a retry. */
      this.sessionCache = null;
    }
  }

  private createSessionBatch(
    entry: z.infer<typeof OutboxEntrySchema>,
    bytes: number,
  ): SessionContextBatch {
    const nowMs = Date.now();
    return {
      createdAt: entry.createdAt,
      events: entry.events.filter((event) => {
        const observedAt = Date.parse(event.observedAt);
        return (
          event.kind !== ContextEventKind.INPUT &&
          observedAt >= nowMs - ContextLimits.SESSION_MS &&
          observedAt <= nowMs
        );
      }),
      scannedEvents: entry.events.length,
      skippedInputEvents: entry.events.filter((event) => event.kind === ContextEventKind.INPUT)
        .length,
      bytes,
    };
  }

  private async encryptEntry(plain: Buffer, key: webcrypto.CryptoKey): Promise<Buffer> {
    const compressed = await compress(plain);
    const nonce = randomBytes(nonceBytes);
    const encrypted = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: formatHeader },
      key,
      compressed,
    );
    return Buffer.concat([formatHeader, nonce, Buffer.from(encrypted)]);
  }

  private async decryptEntry(name: string, key: webcrypto.CryptoKey): Promise<Buffer> {
    const reference = parseJournalReference(name);
    if (reference) {
      return this.decryptPayload(
        await readJournalFrame(
          join(this.directory, reference.file),
          reference.start,
          reference.end,
        ),
        key,
      );
    }
    const path = join(this.directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > ContextLimits.EVENT_BYTES + 1024) {
      throw new Error('Context journal entry has invalid size.');
    }
    return this.decryptPayload(await readFile(path), key);
  }

  private async decryptPayload(bytes: Buffer, key: webcrypto.CryptoKey): Promise<Buffer> {
    const compressed = bytes.subarray(0, formatHeader.byteLength).equals(formatHeader);
    const offset = compressed ? formatHeader.byteLength : 0;
    if (
      bytes.byteLength < offset + nonceBytes + authenticationBytes ||
      bytes.byteLength > ContextLimits.EVENT_BYTES + 1024
    ) {
      throw new Error('Context journal entry has invalid size.');
    }
    const decrypted = await webcrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.subarray(offset, offset + nonceBytes),
        ...(compressed ? { additionalData: formatHeader } : {}),
      },
      key,
      bytes.subarray(offset + nonceBytes),
    );
    const plain = compressed
      ? await decompress(Buffer.from(decrypted), { maxOutputLength: ContextLimits.EVENT_BYTES })
      : Buffer.from(decrypted);
    if (plain.byteLength > ContextLimits.EVENT_BYTES) {
      throw new Error('Context journal entry is oversized.');
    }
    return plain;
  }

  private async readEntry(
    name: string,
    key: webcrypto.CryptoKey,
  ): Promise<{ entry: z.infer<typeof OutboxEntrySchema>; bytes: number }> {
    const plain = await this.decryptEntry(name, key);
    const raw: unknown = JSON.parse(plain.toString('utf8'));
    return { entry: OutboxEntrySchema.parse(raw), bytes: plain.byteLength };
  }

  private async readReceipts(
    file: string,
    key: webcrypto.CryptoKey,
  ): Promise<ContextJournalFrameRange[]> {
    try {
      const raw: unknown = JSON.parse(
        (await this.decryptEntry(`${file}.ack`, key)).toString('utf8'),
      );
      return ReceiptSchema.parse(raw).ranges;
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return [];
      }
      console.warn('context.journal.invalid', { stage: 'receipts', count: 1 });
      throw new Error('Context journal receipts are unavailable.', { cause: error });
    }
  }

  private async saveMetadata(
    name: string,
    value: UploadManifest | z.infer<typeof ReceiptSchema> | MigrationReceipt,
    key: webcrypto.CryptoKey,
  ): Promise<void> {
    const serialized = JSON.stringify(value);
    const plain = Buffer.from(serialized);
    if (plain.byteLength > ContextLimits.EVENT_BYTES) {
      throw new Error('Context journal metadata is oversized.');
    }
    const payload = await this.encryptEntry(plain, key);
    const files = await this.listRetainedFiles();
    const retainedBytes = files.reduce(
      (total, file) => total + (file.name === name ? 0 : file.bytes),
      0,
    );
    if (retainedBytes + payload.byteLength > ContextLimits.OUTBOX_BYTES) {
      throw new Error('Context outbox is full.');
    }
    await writeFile(join(this.directory, `${name}.pending`), payload, { mode: 0o600 });
    await rename(join(this.directory, `${name}.pending`), join(this.directory, name));
  }

  private readManifestName(ownerId: string, generation: number): string {
    return `${readOwnerPrefix(ownerId)}${String(generation)}.upload`;
  }

  private async readManifest(
    ownerId: string,
    generation: number,
    key: webcrypto.CryptoKey,
  ): Promise<UploadManifest | null> {
    const name = this.readManifestName(ownerId, generation);
    try {
      const raw: unknown = JSON.parse((await this.decryptEntry(name, key)).toString('utf8'));
      const manifest = UploadManifestSchema.parse(raw);
      if (
        manifest.ownerId !== ownerId ||
        manifest.generation !== generation ||
        manifest.createdAt + ContextLimits.RETENTION_MS < Date.now() ||
        manifest.names.some((reference) => !reference.startsWith(readOwnerPrefix(ownerId)))
      ) {
        throw new Error('Invalid context upload snapshot.');
      }
      return manifest;
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        console.warn('context.journal.invalid', { stage: 'manifest', count: 1 });
        await rm(join(this.directory, name), { force: true });
      }
      return null;
    }
  }

  private async restoreSnapshot(
    manifest: UploadManifest,
    key: webcrypto.CryptoKey,
  ): Promise<PendingContextJournal | null> {
    const entries: PendingContextEntry[] = [];
    let unsent = 0;
    try {
      for (const name of manifest.names) {
        let decoded: Awaited<ReturnType<ContextOutbox['readEntry']>>;
        const reference = parseJournalReference(name);
        if (reference) {
          decoded = await this.readEntry(name, key);
          if (!isAcknowledged(reference, await this.readReceipts(reference.file, key))) {
            unsent += 1;
          }
        } else {
          try {
            decoded = await this.readEntry(name, key);
            unsent += 1;
          } catch (error: unknown) {
            if (!isMissingFile(error)) {
              throw error;
            }
            decoded = await this.readEntry(name.replace(/\.bin$/u, '.sent.bin'), key);
          }
        }
        if (
          decoded.entry.ownerId !== manifest.ownerId ||
          decoded.entry.generation !== manifest.generation ||
          decoded.entry.createdAt + ContextLimits.RETENTION_MS < Date.now()
        ) {
          throw new Error('Invalid context snapshot entry.');
        }
        entries.push({ name, events: decoded.entry.events });
      }
      if (unsent > 0) {
        return { entries, omittedEntries: manifest.omittedEntries };
      }
    } catch {
      console.warn('context.journal.invalid', { stage: 'snapshot', count: 1 });
    }
    await rm(join(this.directory, this.readManifestName(manifest.ownerId, manifest.generation)), {
      force: true,
    });
    return null;
  }

  /** Search candidates span the current retained session, including previously uploaded frames.
   * This never reads or writes upload manifests/receipts. Cold scans page/yield; warm
   * reads reuse one active scope's source-only cache after checking file metadata. */
  readSession(
    ownerId: string,
    generation: number,
    options: ReadContextSessionOptions = {},
  ): Promise<SessionContextJournal> {
    const maximumBytes = options.maximumBytes ?? ContextSessionReadLimits.MAXIMUM_DECODED_BYTES;
    if (
      !ownerId ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > ContextSessionReadLimits.MAXIMUM_DECODED_BYTES
    ) {
      throw new RangeError('Invalid local session read scope or byte bound.');
    }
    return this.runExclusive(() => this.readSessionEntries(ownerId, generation, maximumBytes));
  }

  private async readSessionEntries(
    ownerId: string,
    generation: number,
    maximumBytes: number,
  ): Promise<SessionContextJournal> {
    const previousCache = this.sessionCache;
    if (
      !previousCache ||
      previousCache.ownerId !== ownerId ||
      previousCache.generation !== generation ||
      previousCache.maximumBytes !== maximumBytes
    ) {
      this.sessionCache = null;
    }
    const key = await this.readKey();
    const nowMs = Date.now();
    const files = selectSessionFiles(await this.listRetainedFiles(), ownerId, generation, nowMs);
    const fingerprint = readSessionFingerprint(files);
    if (this.sessionCache?.fingerprint === fingerprint) {
      return readSessionView(this.sessionCache, nowMs, true);
    }
    const cache: SessionContextCache = {
      ownerId,
      generation,
      maximumBytes,
      fingerprint,
      batches: [],
      decodedBytes: 0,
      scannedEntries: 0,
      omittedEntries: 0,
      partial: false,
    };
    const scan = { reachedBound: false };
    const hasReachedScanBound = (): boolean => scan.reachedBound;
    const omit = (): void => {
      cache.omittedEntries += 1;
      cache.partial = true;
    };
    const admit = async (name: string, payload?: Buffer): Promise<void> => {
      if (hasReachedScanBound()) {
        return;
      }
      if (cache.scannedEntries >= ContextSessionReadLimits.MAXIMUM_FRAMES) {
        scan.reachedBound = true;
        omit();
        return;
      }
      cache.scannedEntries += 1;
      try {
        const plain = payload
          ? await this.decryptPayload(payload, key)
          : await this.decryptEntry(name, key);
        if (cache.decodedBytes + plain.byteLength > maximumBytes) {
          scan.reachedBound = true;
          omit();
          return;
        }
        cache.decodedBytes += plain.byteLength;
        const raw: unknown = JSON.parse(plain.toString('utf8'));
        const entry = OutboxEntrySchema.parse(raw);
        if (
          entry.ownerId !== ownerId ||
          entry.generation !== generation ||
          entry.createdAt < nowMs - ContextLimits.SESSION_MS ||
          entry.createdAt > nowMs
        ) {
          return;
        }
        cache.batches.push(this.createSessionBatch(entry, plain.byteLength));
      } catch {
        omit();
      }
    };
    for (const file of files) {
      if (hasReachedScanBound()) {
        omit();
        continue;
      }
      if (!journalPattern.test(file.name)) {
        await admit(file.name);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continue;
      }
      try {
        let before: number | undefined;
        while (!hasReachedScanBound()) {
          const remaining = ContextSessionReadLimits.MAXIMUM_FRAMES - cache.scannedEntries;
          if (remaining < 1) {
            scan.reachedBound = true;
            omit();
            break;
          }
          const page = await readNewestJournalFrames(join(this.directory, file.name), {
            ...(before === undefined ? {} : { before }),
            limit: Math.min(ContextSessionReadLimits.PAGE_FRAMES, remaining),
            maxBytes: maximumPendingBytes,
          });
          if (page.truncatedTail) {
            omit();
          }
          for (const frame of page.frames) {
            await admit(`${file.name}~${String(frame.start)}-${String(frame.end)}`, frame.payload);
            if (hasReachedScanBound()) {
              break;
            }
          }
          const oldest = page.frames.at(-1);
          if (!oldest) {
            if (page.omitted) {
              omit();
            }
            break;
          }
          if (!page.omitted || oldest.start <= ContextJournalFileLimits.HEADER_BYTES) {
            break;
          }
          before = oldest.start;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      } catch {
        omit();
      }
    }
    this.sessionCache = cache;
    return readSessionView(cache, nowMs, false);
  }

  readPending(ownerId: string, generation: number): Promise<PendingContextJournal> {
    return this.runExclusive(() => this.readPendingSnapshot(ownerId, generation));
  }

  /** Seek newest unacknowledged frames, with bounded reads/decompression. Never inflate a whole log. */
  private async readPendingSnapshot(
    ownerId: string,
    generation: number,
  ): Promise<PendingContextJournal> {
    const key = await this.readKey();
    const prefix = readOwnerPrefix(ownerId);
    const files = await this.listRetainedFiles();
    const manifest = await this.readManifest(ownerId, generation, key);
    if (manifest) {
      const snapshot = await this.restoreSnapshot(manifest, key);
      if (snapshot) {
        return snapshot;
      }
    }
    const selected: DecodedEntry[] = [];
    let decodedBytes = 0;
    let omittedEntries = 0;
    let corruptEntries = 0;
    let decodeAttempts = 0;
    let reachedLimit = false;
    const hasReachedLimit = (): boolean =>
      reachedLimit ||
      selected.length >= maximumPendingEntries ||
      decodeAttempts >= maximumDecodeAttempts;
    const candidates = files
      .filter((file) => {
        if (!file.name.startsWith(prefix)) {
          return false;
        }
        const legacy = legacyReferencePattern.exec(file.name);
        const journal = journalPattern.exec(file.name);
        return legacy
          ? !legacy[2] && (legacy[1] === undefined || Number(legacy[1]) === generation)
          : journal !== null && Number(journal[1]) === generation;
      })
      .sort(
        (left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name),
      );

    const admit = async (name: string, payload?: Buffer): Promise<void> => {
      if (hasReachedLimit()) {
        reachedLimit = true;
        omittedEntries += 1;
        return;
      }
      decodeAttempts += 1;
      try {
        const plain = payload
          ? await this.decryptPayload(payload, key)
          : await this.decryptEntry(name, key);
        const raw: unknown = JSON.parse(plain.toString('utf8'));
        const entry = OutboxEntrySchema.parse(raw);
        if (
          entry.ownerId !== ownerId ||
          entry.generation !== generation ||
          entry.createdAt + ContextLimits.RETENTION_MS < Date.now()
        ) {
          return;
        }
        if (decodedBytes + plain.byteLength > maximumPendingBytes) {
          reachedLimit = true;
          omittedEntries += 1;
          return;
        }
        const observedAt = entry.events.reduce(
          (latest, event) => (event.observedAt > latest ? event.observedAt : latest),
          '',
        );
        selected.push({ name, events: entry.events, observedAt });
        decodedBytes += plain.byteLength;
      } catch {
        corruptEntries += 1;
        omittedEntries += 1;
      }
    };
    for (const file of candidates) {
      if (hasReachedLimit()) {
        omittedEntries += 1;
        continue;
      }
      if (!journalPattern.test(file.name)) {
        if (file.bytes > ContextLimits.EVENT_BYTES + 1024) {
          corruptEntries += 1;
          omittedEntries += 1;
        } else {
          await admit(file.name);
        }
        continue;
      }
      try {
        const page = await readNewestJournalFrames(join(this.directory, file.name), {
          excludeRanges: await this.readReceipts(file.name, key),
          limit: maximumDecodeAttempts - decodeAttempts,
          maxBytes: maximumPendingBytes,
        });
        for (const frame of page.frames) {
          await admit(`${file.name}~${String(frame.start)}-${String(frame.end)}`, frame.payload);
        }
        if (page.omitted || page.truncatedTail) {
          omittedEntries += 1;
        }
      } catch {
        corruptEntries += 1;
        omittedEntries += 1;
      }
    }
    selected.sort(compareChronology);
    if (corruptEntries) {
      console.warn('context.journal.invalid', { stage: 'read', count: corruptEntries });
    }
    if (selected.length) {
      const snapshot: UploadManifest = {
        ownerId,
        generation,
        createdAt: Date.now(),
        names: selected.map((entry) => entry.name),
        omittedEntries,
      };
      await this.saveMetadata(this.readManifestName(ownerId, generation), snapshot, key);
    }
    return { entries: selected.map(({ name, events }) => ({ name, events })), omittedEntries };
  }

  /** Acknowledge successful ingestion without deleting the local raw originals.
   * Repeating acknowledgement is safe after a partial rename or app restart. */
  acknowledge(names: string[]): Promise<void> {
    return this.runExclusive(() => this.acknowledgeEntries(names));
  }

  private async acknowledgeEntries(names: string[]): Promise<void> {
    const key = await this.readKey();
    const journals = new Map<string, ContextJournalFrameRange[]>();
    for (const name of names) {
      validateReference(name);
      const reference = parseJournalReference(name);
      if (reference) {
        const ranges = journals.get(reference.file) ?? [];
        ranges.push({ start: reference.start, end: reference.end });
        journals.set(reference.file, ranges);
      } else if (!name.endsWith('.sent.bin')) {
        try {
          await rename(
            join(this.directory, name),
            join(this.directory, name.replace(/\.bin$/u, '.sent.bin')),
          );
        } catch (error: unknown) {
          if (!isMissingFile(error)) {
            throw error;
          }
        }
      }
    }
    for (const [file, ranges] of journals) {
      for (const range of ranges) {
        await readJournalFrame(join(this.directory, file), range.start, range.end);
      }
      const receipts = ReceiptSchema.parse({
        ranges: mergeRanges([...(await this.readReceipts(file, key)), ...ranges]),
      });
      await this.saveMetadata(`${file}.ack`, receipts, key);
    }
  }

  forget(ownerId: string): Promise<void> {
    return this.runExclusive(() => this.forgetOwner(ownerId));
  }

  private async forgetOwner(ownerId: string): Promise<void> {
    if (this.sessionCache?.ownerId === ownerId) {
      this.sessionCache = null;
    }
    const prefix = readOwnerPrefix(ownerId);
    const names = await readdir(this.directory).catch((): string[] => []);
    for (const name of names) {
      const reference = name.endsWith('.pending') ? name.slice(0, -'.pending'.length) : name;
      if (name.startsWith(prefix) && isOwnedFile(reference)) {
        await rm(join(this.directory, name), { force: true });
      }
    }
  }
}
