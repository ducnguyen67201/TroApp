import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
  truncate,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ContextOutbox } from '../../../../src/desktop/main/context/ContextOutbox.js';
import {
  appendJournalFrame,
  readNewestJournalFrames,
} from '../../../../src/desktop/main/context/ContextJournalFile.js';
import { ContextPreferences } from '../../../../src/desktop/main/context/ContextPreferences.js';
import {
  ContextEventKind,
  ContextLimits,
  type ContextEvent,
} from '../../../../src/contracts/StudyContext.js';

const protect = (value: string): Buffer => Buffer.from(value, 'utf8');
const unprotect = (value: Buffer): string => value.toString('utf8');

function createEvent(
  text = 'private exact project text',
  observedAt = new Date().toISOString(),
): ContextEvent {
  return {
    id: randomUUID(),
    kind: ContextEventKind.OBSERVATION,
    resource: 'Scratch',
    observedAt,
    text,
    limitation: 'fixture',
  };
}

function readBackingName(reference: string): string {
  const name = reference.split('~')[0];
  if (!name) {
    throw new Error('Missing journal filename.');
  }
  return name;
}

async function writeLegacyEntry(
  directory: string,
  ownerId: string,
  generation: number,
  events: ContextEvent[],
  rawKey: Buffer,
  createdAt = Date.now(),
): Promise<string> {
  const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const nonce = randomBytes(12);
  const encrypted = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    Buffer.from(JSON.stringify({ ownerId, generation, createdAt, events })),
  );
  const name = `${createHash('sha256').update(ownerId).digest('hex')}-${randomUUID()}.bin`;
  await writeFile(join(directory, name), Buffer.concat([nonce, Buffer.from(encrypted)]));
  return name;
}

it('compresses/encrypts exact evidence for the same owner/generation and preserves opt-out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const events = [createEvent('private exact project text '.repeat(1000))];
    const name = await outbox.save('student', 1, events);
    expect(name).toMatch(/\.journal~\d+-\d+$/u);
    const binary = await readFile(join(directory, readBackingName(name)));
    expect(binary.includes(Buffer.from('private exact project text'))).toBe(false);
    expect(binary.byteLength).toBeLessThan(2000);
    expect(await outbox.readPending('other', 1)).toEqual({ entries: [], omittedEntries: 0 });
    expect(await outbox.readPending('student', 2)).toEqual({ entries: [], omittedEntries: 0 });
    const restored = new ContextOutbox(directory, protect, unprotect);
    expect(await restored.readPending('student', 1)).toEqual({
      entries: [{ name, events }],
      omittedEntries: 0,
    });
    const preferences = new ContextPreferences(join(directory, 'preferences'));
    expect(await preferences.read('student')).toBeNull();
    await preferences.save('student', false);
    expect(await preferences.read('student')).toBe(false);
    expect(await preferences.read('other')).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('appends multiple capture batches to one hourly log without rewriting older encrypted bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const first = await outbox.save('student', 1, [createEvent('first')]);
    const firstBytes = await readFile(join(directory, readBackingName(first)));
    const references = [first];
    for (let index = 0; index < 12; index += 1) {
      references.push(await outbox.save('student', 1, [createEvent(String(index))]));
    }
    expect(new Set(references.map(readBackingName)).size).toBe(1);
    expect(new Set(references).size).toBe(13);
    expect((await readdir(directory)).filter((name) => name.endsWith('.journal'))).toEqual([
      readBackingName(first),
    ]);
    const appendedBytes = await readFile(join(directory, readBackingName(first)));
    expect(appendedBytes.byteLength).toBeGreaterThan(firstBytes.byteLength);
    expect(appendedBytes.subarray(0, firstBytes.byteLength)).toEqual(firstBytes);
    expect((await outbox.readPending('student', 1)).entries).toHaveLength(13);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rotates the append log at the next hour while retaining readable records from both logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  const firstTime = Math.floor(Date.now() / 3600000) * 3600000 + 10000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(firstTime);
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const first = await outbox.save('student', 1, [
      createEvent('first hour', new Date(firstTime).toISOString()),
    ]);
    now.mockReturnValue(firstTime + 3600000);
    const second = await outbox.save('student', 1, [
      createEvent('next hour', new Date(firstTime + 3600000).toISOString()),
    ]);
    expect(readBackingName(first)).not.toBe(readBackingName(second));
    expect((await readdir(directory)).filter((name) => name.endsWith('.journal'))).toHaveLength(2);
    expect((await outbox.readPending('student', 1)).entries.map((entry) => entry.name)).toEqual([
      first,
      second,
    ]);
  } finally {
    now.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('acknowledges ranges without deleting originals, and forgetting removes owner logs and receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const name = await outbox.save('student', 1, [createEvent()]);
    const backingName = readBackingName(name);
    const original = await readFile(join(directory, backingName));
    await outbox.readPending('student', 1);
    await outbox.acknowledge([name]);
    await outbox.acknowledge([name]);
    expect(await outbox.readPending('student', 1)).toEqual({ entries: [], omittedEntries: 0 });
    expect(await readFile(join(directory, backingName))).toEqual(original);
    expect((await readdir(directory)).includes(`${backingName}.ack`)).toBe(true);
    await outbox.save('student', 1, [createEvent()]);
    const other = await outbox.save('other', 1, [createEvent()]);
    await outbox.forget('student');
    const names = await readdir(directory);
    const ownerPrefix = createHash('sha256').update('student').digest('hex');
    expect(names.some((file) => file.startsWith(ownerPrefix))).toBe(false);
    expect(names.filter((file) => file.endsWith('.journal'))).toEqual([readBackingName(other)]);
    await expect(outbox.acknowledge(['../outside.bin'])).rejects.toThrow(
      'Invalid outbox reference',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not mark an older pending frame uploaded when only a newer frame is acknowledged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const older = await outbox.save('student', 1, [createEvent('older')]);
    const newer = await outbox.save('student', 1, [createEvent('newer')]);
    expect(readBackingName(older)).toBe(readBackingName(newer));
    await outbox.acknowledge([newer]);
    expect((await outbox.readPending('student', 1)).entries.map((entry) => entry.name)).toEqual([
      older,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reads legacy uncompressed encrypted entries without rewriting the stored evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const rawKey = randomBytes(32);
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const events = [createEvent()];
    const name = await writeLegacyEntry(directory, 'student', 1, events, rawKey);
    const outbox = new ContextOutbox(directory, protect, unprotect);
    expect(await outbox.readPending('student', 1)).toEqual({
      entries: [{ name, events }],
      omittedEntries: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('filters old generations and reports a corrupt legacy file without logging its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    for (let index = 0; index < 25; index += 1) {
      await outbox.save('student', 0, [createEvent()]);
    }
    const bad = `${createHash('sha256').update('student').digest('hex')}-1-${randomUUID()}.bin`;
    await writeFile(join(directory, bad), Buffer.from('private bad source'));
    const events = [createEvent('new generation')];
    const name = await outbox.save('student', 1, events);
    expect(await outbox.readPending('student', 1)).toEqual({
      entries: [{ name, events }],
      omittedEntries: 1,
    });
    expect(warn).toHaveBeenCalledWith('context.journal.invalid', { stage: 'read', count: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private bad source');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(bad);
  } finally {
    warn.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps the newest bounded frames in chronological order and reports additional pending history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const base = Date.now() - 100000;
    for (let index = 0; index < 70; index += 1) {
      await outbox.save('student', 1, [
        createEvent(String(index), new Date(base + index * 1000).toISOString()),
      ]);
    }
    const result = await outbox.readPending('student', 1);
    expect(result.omittedEntries).toBeGreaterThan(0);
    expect(result.entries).toHaveLength(64);
    expect(result.entries[0]?.events[0]?.text).toBe('6');
    expect(result.entries.at(-1)?.events[0]?.text).toBe('69');
    expect(await outbox.readPending('student', 1)).toEqual(result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds decoded snapshot bytes even when repeated text compresses to tiny frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    for (let index = 0; index < 22; index += 1) {
      await outbox.save(
        'student',
        1,
        Array.from({ length: 7 }, () => createEvent('x'.repeat(30000))),
      );
    }
    const result = await outbox.readPending('student', 1);
    expect(result.entries.length).toBeLessThan(22);
    expect(result.omittedEntries).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.entries))).toBeLessThan(4 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('freezes frame ranges across capture, restarts and partial acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const first = await outbox.save('student', 1, [createEvent('first')]);
    const second = await outbox.save('student', 1, [createEvent('second')]);
    const snapshot = await outbox.readPending('student', 1);
    const later = await outbox.save('student', 1, [createEvent('later')]);
    const restored = new ContextOutbox(directory, protect, unprotect);
    expect(await restored.readPending('student', 1)).toEqual(snapshot);
    await restored.acknowledge([first]);
    expect(await restored.readPending('student', 1)).toEqual(snapshot);
    await restored.acknowledge([first, second]);
    expect((await restored.readPending('student', 1)).entries.map((entry) => entry.name)).toEqual([
      later,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('prunes expired legacy pending and acknowledged originals on append even without Ask', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const rawKey = randomBytes(32);
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const pending = await writeLegacyEntry(
      directory,
      'student',
      1,
      [createEvent('pending')],
      rawKey,
    );
    const sent = await writeLegacyEntry(directory, 'student', 1, [createEvent('sent')], rawKey);
    const outbox = new ContextOutbox(directory, protect, unprotect);
    await outbox.acknowledge([sent]);
    const expiredAt = new Date(Date.now() - ContextLimits.RETENTION_MS - 10000);
    await utimes(join(directory, pending), expiredAt, expiredAt);
    await utimes(join(directory, sent.replace(/\.bin$/u, '.sent.bin')), expiredAt, expiredAt);
    const latest = await outbox.save('student', 1, [createEvent('latest')]);
    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith('.bin'))).toEqual([]);
    expect(names.includes(readBackingName(latest))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('excludes expired journal records by creation time after restarting even if file mtime is recent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  const currentTime = Date.now();
  const oldTime = currentTime - ContextLimits.RETENTION_MS - 10000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(oldTime);
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    await outbox.save('student', 1, [createEvent('expired', new Date(oldTime).toISOString())]);
    now.mockReturnValue(currentTime);
    const restored = new ContextOutbox(directory, protect, unprotect);
    expect((await restored.readPending('student', 1)).entries).toEqual([]);
  } finally {
    now.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds disk bytes for journal appends, frozen manifests and acknowledgement receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const saved = await outbox.save('student', 1, [createEvent()]);
    const backingName = readBackingName(saved);
    const savedBytes = (await readFile(join(directory, backingName))).byteLength;
    const filler = `${createHash('sha256').update('other').digest('hex')}-1-${randomUUID()}.sent.bin`;
    await writeFile(join(directory, filler), Buffer.alloc(0));
    await truncate(join(directory, filler), ContextLimits.OUTBOX_BYTES - savedBytes);
    await expect(outbox.readPending('student', 1)).rejects.toThrow('Context outbox is full');
    await expect(outbox.save('student', 1, [createEvent()])).rejects.toThrow(
      'Context outbox is full',
    );
    await expect(outbox.acknowledge([saved])).rejects.toThrow('Context outbox is full');
    expect((await readdir(directory)).some((name) => name.endsWith('.upload'))).toBe(false);
    expect(await readFile(join(directory, backingName))).not.toHaveLength(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function readMigratedName(ownerId: string, generation: number, createdAt: number): string {
  const prefix = createHash('sha256').update(ownerId).digest('hex');
  const hour = new Date(createdAt).toISOString().slice(0, 13).replace(/[-:]/gu, '');
  return `${prefix}-${String(generation)}-${hour}-Migrated.journal`;
}

async function writeMigrationReceipt(
  directory: string,
  rawKey: Buffer,
  value: {
    ownerId: string;
    generation: number;
    createdAt: number;
    oldName: string;
    newReference: string;
    payloadDigest: string;
    sent: boolean;
  },
): Promise<string> {
  const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const nonce = randomBytes(12);
  const encrypted = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    Buffer.from(JSON.stringify(value)),
  );
  const name = `${createHash('sha256').update(value.ownerId).digest('hex')}-${String(value.generation)}.migrate`;
  await writeFile(join(directory, name), Buffer.concat([nonce, Buffer.from(encrypted)]));
  return name;
}

it('skips protected storage entirely when there are no legacy records to consolidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-consolidate-'));
  const protectKey = vi.fn<(value: string) => Buffer>().mockImplementation(protect);
  const unprotectKey = vi.fn<(value: Buffer) => string>().mockImplementation(unprotect);
  try {
    const outbox = new ContextOutbox(directory, protectKey, unprotectKey);
    expect(await outbox.consolidateLegacyLogs()).toEqual({ migrated: 0, expired: 0, failed: 0 });
    expect(protectKey).not.toHaveBeenCalled();
    expect(unprotectKey).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('consolidates pending and acknowledged ciphertext while keeping original timestamps and frozen context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-consolidate-'));
  const rawKey = randomBytes(32);
  const createdAt = Math.floor(Date.now() / 3600000) * 3600000 - 2 * 3600000 + 10000;
  try {
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const pendingEvents = [createEvent('earlier assignment', new Date(createdAt).toISOString())];
    const sentEvents = [createEvent('already uploaded', new Date(createdAt + 1).toISOString())];
    const pending = await writeLegacyEntry(
      directory,
      'student',
      1,
      pendingEvents,
      rawKey,
      createdAt,
    );
    const sent = await writeLegacyEntry(directory, 'student', 1, sentEvents, rawKey, createdAt + 1);
    const originalPayloads = [
      await readFile(join(directory, pending)),
      await readFile(join(directory, sent)),
    ];
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const before = await outbox.readPending('student', 1);
    await outbox.acknowledge([sent]);
    const normal = await outbox.save('student', 1, [createEvent('current screen')]);
    expect(await outbox.consolidateLegacyLogs()).toEqual({ migrated: 2, expired: 0, failed: 0 });
    const after = await outbox.readPending('student', 1);
    expect(after.entries.map((entry) => entry.events)).toEqual(
      before.entries.map((entry) => entry.events),
    );
    expect(after.omittedEntries).toBe(before.omittedEntries);
    expect(after.entries.every((entry) => entry.name.includes('-Migrated.journal~'))).toBe(true);
    const names = await readdir(directory);
    expect(names.some((name) => name.endsWith('.bin') || name.endsWith('.migrate'))).toBe(false);
    expect(names).toContain(readBackingName(normal));
    const migratedName = readMigratedName('student', 1, createdAt);
    const page = await readNewestJournalFrames(join(directory, migratedName), {
      limit: 10,
      maxBytes: ContextLimits.EVENT_BYTES,
    });
    expect(page.frames).toHaveLength(2);
    expect(
      originalPayloads.every((payload) =>
        page.frames.some((frame) => frame.payload.equals(payload)),
      ),
    ).toBe(true);
    expect((await stat(join(directory, migratedName))).mtimeMs).toBeLessThanOrEqual(createdAt + 2);
    await outbox.acknowledge(after.entries.map((entry) => entry.name));
    expect((await outbox.readPending('student', 1)).entries.map((entry) => entry.name)).toEqual([
      normal,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves a source and retry receipt when its frozen manifest is corrupt, then resumes safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-consolidate-'));
  const rawKey = randomBytes(32);
  try {
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const oldName = await writeLegacyEntry(
      directory,
      'student',
      1,
      [createEvent('private source')],
      rawKey,
    );
    const original = await readFile(join(directory, oldName));
    const outbox = new ContextOutbox(directory, protect, unprotect);
    await outbox.readPending('student', 1);
    const manifestName = `${createHash('sha256').update('student').digest('hex')}-1.upload`;
    const originalManifest = await readFile(join(directory, manifestName));
    await writeFile(join(directory, manifestName), Buffer.from('corrupt encrypted manifest'));
    expect(await outbox.consolidateLegacyLogs()).toEqual({ migrated: 0, expired: 0, failed: 1 });
    expect(await readFile(join(directory, oldName))).toEqual(original);
    expect(await readFile(join(directory, manifestName))).toEqual(
      Buffer.from('corrupt encrypted manifest'),
    );
    expect((await readdir(directory)).some((name) => name.endsWith('.migrate'))).toBe(true);
    await writeFile(join(directory, manifestName), originalManifest);
    const restored = new ContextOutbox(directory, protect, unprotect);
    expect(await restored.consolidateLegacyLogs()).toEqual({ migrated: 1, expired: 0, failed: 0 });
    expect(
      (await readdir(directory)).some((name) => name.endsWith('.bin') || name.endsWith('.migrate')),
    ).toBe(false);
    expect((await restored.readPending('student', 1)).entries[0]?.events[0]?.text).toBe(
      'private source',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('resumes a durable receipt after the source was removed and rewrites the old manifest reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-consolidate-'));
  const rawKey = randomBytes(32);
  const createdAt = Math.floor(Date.now() / 3600000) * 3600000 + 10000;
  try {
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const oldName = await writeLegacyEntry(
      directory,
      'student',
      1,
      [createEvent('resume after deletion')],
      rawKey,
      createdAt,
    );
    const payload = await readFile(join(directory, oldName));
    const outbox = new ContextOutbox(directory, protect, unprotect);
    await outbox.readPending('student', 1);
    const journal = readMigratedName('student', 1, createdAt);
    const range = await appendJournalFrame(join(directory, journal), payload);
    const newReference = `${journal}~${String(range.start)}-${String(range.end)}`;
    await writeMigrationReceipt(directory, rawKey, {
      ownerId: 'student',
      generation: 1,
      createdAt,
      oldName,
      newReference,
      payloadDigest: createHash('sha256').update(payload).digest('hex'),
      sent: false,
    });
    await rm(join(directory, oldName));
    expect(await outbox.consolidateLegacyLogs()).toEqual({ migrated: 1, expired: 0, failed: 0 });
    expect((await outbox.readPending('student', 1)).entries[0]?.name).toBe(newReference);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reuses orphan ciphertext even when later records were appended before consolidation resumes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-consolidate-'));
  const rawKey = randomBytes(32);
  const createdAt = Math.floor(Date.now() / 3600000) * 3600000 + 10000;
  try {
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const first = await writeLegacyEntry(
      directory,
      'student',
      1,
      [createEvent('orphan')],
      rawKey,
      createdAt,
    );
    const second = await writeLegacyEntry(
      directory,
      'student',
      1,
      [createEvent('later orphan')],
      rawKey,
      createdAt + 1,
    );
    const journal = readMigratedName('student', 1, createdAt);
    await appendJournalFrame(join(directory, journal), await readFile(join(directory, first)));
    await appendJournalFrame(join(directory, journal), await readFile(join(directory, second)));
    const outbox = new ContextOutbox(directory, protect, unprotect);
    expect(await outbox.consolidateLegacyLogs()).toEqual({ migrated: 2, expired: 0, failed: 0 });
    const page = await readNewestJournalFrames(join(directory, journal), {
      limit: 10,
      maxBytes: ContextLimits.EVENT_BYTES,
    });
    expect(page.frames).toHaveLength(2);
    expect((await outbox.readPending('student', 1)).entries).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('expires old legacy records without copying them and leaves corrupt sources untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-consolidate-'));
  const rawKey = randomBytes(32);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const expired = await writeLegacyEntry(
      directory,
      'student',
      1,
      [createEvent('expired')],
      rawKey,
      Date.now() - ContextLimits.RETENTION_MS - 1,
    );
    const invalid = `${createHash('sha256').update('other').digest('hex')}-${randomUUID()}.bin`;
    await writeFile(join(directory, invalid), Buffer.from('private invalid data'));
    const outbox = new ContextOutbox(directory, protect, unprotect);
    expect(await outbox.consolidateLegacyLogs()).toEqual({ migrated: 0, expired: 1, failed: 1 });
    expect((await readdir(directory)).includes(expired)).toBe(false);
    expect(await readFile(join(directory, invalid))).toEqual(Buffer.from('private invalid data'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private invalid data');
  } finally {
    warn.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
