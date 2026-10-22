import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  appendJournalFrame,
  ContextJournalFileLimits,
  readJournalFrame,
  readNewestJournalFrames,
} from '../../../../src/desktop/main/context/ContextJournalFile.js';

async function createJournalDirectory(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'tro-journal-framing-'));
  return { directory, path: join(directory, 'session.journal') };
}

it('appends batches to one log and reads a bounded newest-first page', async () => {
  const { directory, path } = await createJournalDirectory();
  try {
    const first = await appendJournalFrame(path, Buffer.from('first encrypted batch'));
    const second = await appendJournalFrame(path, Buffer.from('second encrypted batch'));
    const third = await appendJournalFrame(path, Buffer.from('third encrypted batch'));
    expect(await readdir(directory)).toEqual(['session.journal']);
    expect(first.start).toBe(ContextJournalFileLimits.HEADER_BYTES);
    expect(second.start).toBe(first.end);
    expect(third.start).toBe(second.end);
    expect((await stat(path)).size).toBe(third.end);
    const page = await readNewestJournalFrames(path, { limit: 2, maxBytes: 1000 });
    expect(page.frames.map((frame) => frame.payload.toString('utf8'))).toEqual([
      'third encrypted batch',
      'second encrypted batch',
    ]);
    expect(page.omitted).toBe(true);
    expect(page.truncatedTail).toBe(false);
    expect(page.validEnd).toBe(third.end);
    expect(await readJournalFrame(path, second.start, second.end)).toEqual(
      Buffer.from('second encrypted batch'),
    );
    const older = await readNewestJournalFrames(path, {
      before: second.start,
      limit: 2,
      maxBytes: 1000,
    });
    expect(older.frames.map((frame) => frame.payload.toString('utf8'))).toEqual([
      'first encrypted batch',
    ]);
    expect(older.omitted).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('respects byte budgets, frozen end offsets and nonzero acknowledged boundaries', async () => {
  const { directory, path } = await createJournalDirectory();
  try {
    const first = await appendJournalFrame(path, Buffer.from('aaaa'));
    const second = await appendJournalFrame(path, Buffer.from('bbbb'));
    await appendJournalFrame(path, Buffer.from('cccc'));
    const budget = await readNewestJournalFrames(path, { limit: 10, maxBytes: 4 });
    expect(budget.frames.map((frame) => frame.payload.toString('utf8'))).toEqual(['cccc']);
    expect(budget.omitted).toBe(true);
    const frozen = await readNewestJournalFrames(path, {
      before: second.end,
      minimumOffset: first.end,
      limit: 10,
      maxBytes: 1000,
    });
    expect(frozen.frames.map((frame) => frame.payload.toString('utf8'))).toEqual(['bbbb']);
    expect(frozen.omitted).toBe(false);
    await expect(
      readNewestJournalFrames(path, { minimumOffset: first.end + 1, limit: 10, maxBytes: 1000 }),
    ).rejects.toThrow('cursor splits a frame');
    await expect(readJournalFrame(path, first.start, second.end)).rejects.toThrow(
      'does not name one frame',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('skips acknowledged ranges without losing older unacknowledged frames', async () => {
  const { directory, path } = await createJournalDirectory();
  try {
    const first = await appendJournalFrame(path, Buffer.from('old pending'));
    const second = await appendJournalFrame(path, Buffer.from('already acknowledged'));
    const third = await appendJournalFrame(path, Buffer.from('new pending'));
    const page = await readNewestJournalFrames(path, {
      excludeRanges: [second],
      limit: 10,
      maxBytes: 1000,
    });
    expect(page.frames.map((frame) => frame.payload.toString('utf8'))).toEqual([
      'new pending',
      'old pending',
    ]);
    expect(page.omitted).toBe(false);
    const complete = await readNewestJournalFrames(path, {
      excludeRanges: [second, third, first],
      limit: 10,
      maxBytes: 1000,
    });
    expect(complete.frames).toEqual([]);
    expect(complete.omitted).toBe(false);
    await expect(
      readNewestJournalFrames(path, {
        excludeRanges: [{ start: first.start, end: third.end + 1 }],
        limit: 10,
        maxBytes: 1000,
      }),
    ).rejects.toThrow('Invalid context journal boundary');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reports an incomplete crash tail and repairs it before the next append', async () => {
  const { directory, path } = await createJournalDirectory();
  try {
    const first = await appendJournalFrame(path, Buffer.from('complete batch'));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(20);
    await appendFile(path, Buffer.concat([prefix, Buffer.from('partial')]));
    const damaged = await readNewestJournalFrames(path, { limit: 10, maxBytes: 1000 });
    expect(damaged.frames.map((frame) => frame.payload.toString('utf8'))).toEqual([
      'complete batch',
    ]);
    expect(damaged.truncatedTail).toBe(true);
    expect(damaged.omitted).toBe(true);
    expect(damaged.validEnd).toBe(first.end);
    const recovered = await appendJournalFrame(path, Buffer.from('recovered batch'));
    expect(recovered.start).toBe(first.end);
    const page = await readNewestJournalFrames(path, { limit: 10, maxBytes: 1000 });
    expect(page.frames.map((frame) => frame.payload.toString('utf8'))).toEqual([
      'recovered batch',
      'complete batch',
    ]);
    expect(page.truncatedTail).toBe(false);
    expect(await readJournalFrame(path, first.start, first.end)).toEqual(
      Buffer.from('complete batch'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects corrupt complete framing without truncating existing history', async () => {
  const { directory, path } = await createJournalDirectory();
  try {
    await appendJournalFrame(path, Buffer.from('first valid batch'));
    const second = await appendJournalFrame(path, Buffer.from('second valid batch'));
    const bytes = await readFile(path);
    bytes.writeUInt32BE(2, second.end - 4);
    await writeFile(path, bytes);
    await expect(appendJournalFrame(path, Buffer.from('new batch'))).rejects.toThrow(
      'corrupt complete frame',
    );
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('serializes concurrent appends and leaves no per-batch files', async () => {
  const { directory, path } = await createJournalDirectory();
  try {
    const records = Array.from({ length: 30 }, (_, index) =>
      Buffer.from(`encrypted-${String(index)}`),
    );
    const ranges = await Promise.all(records.map((payload) => appendJournalFrame(path, payload)));
    expect(await readdir(directory)).toEqual(['session.journal']);
    expect(new Set(ranges.map((range) => range.start)).size).toBe(records.length);
    const page = await readNewestJournalFrames(path, { limit: 30, maxBytes: 10000 });
    expect(page.frames.map((frame) => frame.payload)).toEqual([...records].reverse());
    expect(page.omitted).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds untrusted sizes and recovers an interrupted initial header only', async () => {
  const { directory, path } = await createJournalDirectory();
  try {
    await expect(
      appendJournalFrame(path, Buffer.alloc(ContextJournalFileLimits.MAXIMUM_PAYLOAD_BYTES + 1)),
    ).rejects.toThrow('Invalid context journal boundary');
    await writeFile(path, Buffer.from('TRO'));
    await appendJournalFrame(path, Buffer.from('first batch'));
    expect((await readNewestJournalFrames(path, { limit: 1, maxBytes: 1000 })).frames).toHaveLength(
      1,
    );
    await expect(readNewestJournalFrames(path, { limit: 0, maxBytes: 1000 })).rejects.toThrow(
      'Invalid context journal boundary',
    );
    await expect(readNewestJournalFrames(path, { limit: 1, maxBytes: 0 })).rejects.toThrow(
      'Invalid context journal boundary',
    );
    const foreignPath = join(directory, 'foreign.journal');
    const foreign = Buffer.from('unrelated content');
    await writeFile(foreignPath, foreign);
    await expect(appendJournalFrame(foreignPath, Buffer.from('batch'))).rejects.toThrow(
      'Unsupported context journal format',
    );
    expect(await readFile(foreignPath)).toEqual(foreign);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
