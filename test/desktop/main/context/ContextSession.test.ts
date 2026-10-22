import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  ContextOutbox,
  ContextSessionReadLimits,
} from '../../../../src/desktop/main/context/ContextOutbox.js';
import {
  ContextEventKind,
  ContextLimits,
  type ContextEvent,
} from '../../../../src/contracts/StudyContext.js';

const protect = (value: string): Buffer => Buffer.from(value, 'utf8');
const unprotect = (value: Buffer): string => value.toString('utf8');

function createEvent(text: string, observedAt = new Date().toISOString()): ContextEvent {
  return {
    id: randomUUID(),
    kind: ContextEventKind.OBSERVATION,
    resource: 'synthetic-study-workspace',
    observedAt,
    text,
    limitation: 'Synthetic evidence; no inference about learner understanding.',
  };
}

function readBackingName(reference: string): string {
  const name = reference.split('~')[0];
  if (!name) {
    throw new Error('Missing synthetic journal filename.');
  }
  return name;
}

it('reads the full session beyond pending selection and leaves retry and acknowledgement state intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const assignment = createEvent('Assignment: repeat the movement seven times.');
    const first = await outbox.save('student', 1, [assignment]);
    for (let index = 0; index < 70; index += 1) {
      await outbox.save('student', 1, [createEvent(`Unrelated screen ${String(index)}.`)]);
    }
    const pending = await outbox.readPending('student', 1);
    expect(pending.entries).toHaveLength(64);
    expect(pending.entries.flatMap((entry) => entry.events)).not.toContainEqual(assignment);
    const names = (await readdir(directory)).sort();
    const journalBefore = await readFile(join(directory, readBackingName(first)));
    const session = await outbox.readSession('student', 1);
    expect(session.events).toHaveLength(71);
    expect(session.events).toContainEqual(assignment);
    expect(session).toMatchObject({ partial: false, omittedEntries: 0, cacheHit: false });
    expect((await readdir(directory)).sort()).toEqual(names);
    expect(await outbox.readPending('student', 1)).toEqual(pending);
    await outbox.acknowledge(pending.entries.map((entry) => entry.name));
    expect((await outbox.readSession('student', 1)).events).toContainEqual(assignment);
    expect(await readFile(join(directory, readBackingName(first)))).toEqual(journalBefore);
    const restored = new ContextOutbox(directory, protect, unprotect);
    expect((await restored.readSession('student', 1)).events).toHaveLength(71);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reuses its scoped cache and updates it after append while preserving the frozen pending upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  const decrypt = vi.spyOn(webcrypto.subtle, 'decrypt');
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const first = createEvent('Assignment: build a guessing game.');
    await outbox.save('student', 1, [first]);
    const pending = await outbox.readPending('student', 1);
    const cold = await outbox.readSession('student', 1);
    const decryptions = decrypt.mock.calls.length;
    const warm = await outbox.readSession('student', 1);
    expect(warm).toEqual({ ...cold, cacheHit: true });
    expect(decrypt.mock.calls).toHaveLength(decryptions);
    const error = createEvent('ValueError: invalid literal for int().');
    await outbox.save('student', 1, [error]);
    const updated = await outbox.readSession('student', 1);
    expect(updated).toMatchObject({ cacheHit: true, partial: false, scannedEntries: 2 });
    expect(updated.events).toEqual(expect.arrayContaining([first, error]));
    expect(decrypt.mock.calls).toHaveLength(decryptions);
    expect(await outbox.readPending('student', 1)).toEqual(pending);
    const returnedEvent = updated.events[0];
    if (returnedEvent) {
      returnedEvent.text = 'Changed caller copy.';
    }
    expect((await outbox.readSession('student', 1)).events).toContainEqual(first);
  } finally {
    decrypt.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('isolates owners and generations, skips physical input text and rejects future observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const first = createEvent('Assignment for the first owner.');
    const second = createEvent('Assignment for a different owner.');
    const nextGeneration = createEvent('Assignment after forgetting history.');
    const input = {
      ...createEvent('Raw physical input metadata.'),
      kind: ContextEventKind.INPUT,
    };
    await outbox.save('student', 1, [first, input]);
    await outbox.save('other', 1, [second]);
    await outbox.save('student', 2, [nextGeneration]);
    await outbox.save('student', 1, [
      createEvent('Future evidence is unavailable.', new Date(Date.now() + 60_000).toISOString()),
    ]);
    const result = await outbox.readSession('student', 1);
    expect(result.events).toEqual([first]);
    expect(result).toMatchObject({ scannedEvents: 3, skippedInputEvents: 1, partial: false });
    expect((await outbox.readSession('other', 1)).events).toEqual([second]);
    expect((await outbox.readSession('student', 2)).events).toEqual([nextGeneration]);
    expect((await outbox.readSession('student', 1)).events).toEqual([first]);
    await outbox.forget('student');
    expect((await outbox.readSession('student', 1)).events).toEqual([]);
    expect((await outbox.readSession('other', 1)).events).toEqual([second]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('expires cached session evidence when time advances without requiring a file change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  const start = Date.now();
  let nowMs = start;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const assignment = createEvent('Assignment: make seven turns.', new Date(start).toISOString());
    await outbox.save('student', 1, [assignment]);
    expect((await outbox.readSession('student', 1)).events).toEqual([assignment]);
    nowMs += ContextLimits.SESSION_MS + 1;
    expect((await outbox.readSession('student', 1)).events).toEqual([]);
    nowMs += ContextLimits.RETENTION_MS;
    expect((await outbox.readSession('student', 1)).events).toEqual([]);
  } finally {
    clock.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('excludes every version of conflicting event identities on cold and cached reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const original = createEvent('Assignment: repeat seven times.');
    const unrelated = createEvent('ValueError: invalid integer guess.');
    await outbox.save('student', 1, [original, unrelated]);
    await outbox.save('student', 1, [{ ...original, text: 'Assignment: repeat nine times.' }]);
    await outbox.save('student', 1, [original]);

    const cold = await outbox.readSession('student', 1);
    expect(cold.events).toEqual([unrelated]);
    expect(cold).toMatchObject({ partial: true, cacheHit: false });
    expect(cold.omittedEntries).toBeGreaterThan(0);
    expect(await outbox.readSession('student', 1)).toEqual({ ...cold, cacheHit: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reports bounded scan coverage and can rebuild under the normal budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const evidence = createEvent(`Assignment: seven turns. ${'Visible screen text. '.repeat(100)}`);
    await outbox.save('student', 1, [evidence]);
    const bounded = await outbox.readSession('student', 1, { maximumBytes: 100 });
    expect(bounded).toMatchObject({ events: [], partial: true, cacheHit: false });
    expect(bounded.omittedEntries).toBeGreaterThan(0);
    expect((await outbox.readSession('student', 1)).events).toEqual([evidence]);
    expect(() => outbox.readSession('student', 1, { maximumBytes: 0 })).toThrow(RangeError);
    expect(() =>
      outbox.readSession('student', 1, {
        maximumBytes: ContextSessionReadLimits.MAXIMUM_DECODED_BYTES + 1,
      }),
    ).toThrow(RangeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('invalidates cached metadata after external damage and reports an incomplete tail without changing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  try {
    const outbox = new ContextOutbox(directory, protect, unprotect);
    const assignment = createEvent('Assignment: keep this complete record.');
    const reference = await outbox.save('student', 1, [assignment]);
    expect((await outbox.readSession('student', 1)).partial).toBe(false);
    const path = join(directory, readBackingName(reference));
    const original = await readFile(path);
    const damaged = Buffer.concat([original, Buffer.from([0, 0, 0, 100])]);
    await writeFile(path, damaged);
    const recovered = await outbox.readSession('student', 1);
    expect(recovered.events).toEqual([assignment]);
    expect(recovered).toMatchObject({ partial: true, cacheHit: false });
    expect(recovered.omittedEntries).toBeGreaterThan(0);
    expect(await readFile(path)).toEqual(damaged);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reads acknowledged legacy files without renaming them or confusing legacy generations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextSession-'));
  try {
    const rawKey = randomBytes(32);
    await writeFile(join(directory, 'Key'), protect(rawKey.toString('base64')));
    const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const event = createEvent('Legacy acknowledged assignment.');
    const nonce = randomBytes(12);
    const payload = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      Buffer.from(
        JSON.stringify({
          ownerId: 'student',
          generation: 1,
          createdAt: Date.now(),
          events: [event],
        }),
      ),
    );
    const name = `${createHash('sha256').update('student').digest('hex')}-${randomUUID()}.sent.bin`;
    await writeFile(join(directory, name), Buffer.concat([nonce, Buffer.from(payload)]));
    const outbox = new ContextOutbox(directory, protect, unprotect);
    expect((await outbox.readSession('student', 1)).events).toEqual([event]);
    expect((await outbox.readSession('student', 2)).events).toEqual([]);
    expect((await readdir(directory)).includes(name)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
