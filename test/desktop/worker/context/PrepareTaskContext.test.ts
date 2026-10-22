import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  PreparedTaskContext,
  type TaskContextPort,
} from '../../../../src/desktop/worker/context/PrepareTaskContext.js';
import { readCheckpointOutput } from '../../../../src/desktop/worker/context/ReadCheckpointOutput.js';
import {
  ContextFailure,
  ContextLimits,
  type ContextPacket,
} from '../../../../src/contracts/StudyContext.js';

function createPacket(): ContextPacket {
  return {
    generation: 1,
    sessionId: randomUUID(),
    eventRevision: 1,
    checkpoint: null,
    activity: [],
    gaps: [],
    nextCursor: null,
    sources: [
      {
        id: randomUUID(),
        resource: 'Scratch',
        digest: 'fixture',
        text: 'repeat 10',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    ],
  };
}

it('extracts a checkpoint from the same normal output without any model/repair request', async () => {
  const packet = createPacket();
  const request = vi
    .fn<TaskContextPort['request']>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'resolve' ? { kind: 'packet', packet } : { kind: 'accepted', revision: 1 },
      ),
    );
  const context = new PreparedTaskContext(
    {
      scope: { enabled: true, available: true, generation: 1, sessionId: packet.sessionId },
      request,
    },
    new AbortController().signal,
  );
  await context.prepareForQuestion('Why?');
  const update = {
    expectedRevision: 0,
    coveredEventRevision: 1,
    sourceIds: packet.sources.map((source) => source.id),
    summary: 'Testing a loop',
    claims: [],
    openQuestions: ['Why?'],
  };
  expect(
    readCheckpointOutput({ answer: 'Check the loop.', checkpointUpdate: update }, context),
  ).toEqual({ answer: 'Check the loop.' });
  await context.settle();
  expect(request.mock.calls.map(([command]) => command.kind)).toEqual([
    'events',
    'resolve',
    'checkpoint',
  ]);
  expect(context.buildMemoryInput()).toContain('repeat 10');
  expect(context.readInstructions()).toContain('SAME normal response');
  expect(context.readGeneration()).toBe(1);
  expect(
    readCheckpointOutput({ answer: 'Still valid', checkpointUpdate: { malformed: true } }, context),
  ).toEqual({ answer: 'Still valid' });
  await context.settle();
  expect(request).toHaveBeenCalledTimes(3);
});

it('does not extract updates when disabled or after cancellation; omitted memory is not failure', async () => {
  const raw = { answer: 'normal', checkpointUpdate: null };
  expect(readCheckpointOutput(raw)).toBe(raw);
  const abort = new AbortController();
  const request = vi
    .fn<TaskContextPort['request']>()
    .mockResolvedValue({ kind: 'failed', code: ContextFailure.DISABLED });
  const context = new PreparedTaskContext(
    { scope: { enabled: true, available: true, generation: 1, sessionId: randomUUID() }, request },
    abort.signal,
  );
  await context.prepareForQuestion('Why?');
  expect(context.buildMemoryInput()).toContain('unavailable');
  abort.abort();
  context.acceptUpdate({});
  context.recordObservation('capture', 'new text');
  await context.settle();
  expect(request).toHaveBeenCalledTimes(2);
});

it('bounds the entire memory projection while retaining full accepted source content', async () => {
  const packet = createPacket();
  const source = packet.sources[0];
  if (!source) {
    throw new Error('Missing fixture source.');
  }
  source.text = 'x'.repeat(32000);
  packet.checkpoint = {
    expectedRevision: 0,
    revision: 1,
    coveredEventRevision: 1,
    sourceIds: [source.id],
    summary: 's'.repeat(2400),
    claims: Array.from({ length: 16 }, () => ({
      text: 'c'.repeat(1000),
      sourceIds: [source.id],
      status: 'model_inferred' as const,
    })),
    openQuestions: Array.from({ length: 12 }, () => 'q'.repeat(400)),
  };
  const request = vi.fn<TaskContextPort['request']>().mockResolvedValue({ kind: 'packet', packet });
  const context = new PreparedTaskContext(
    {
      scope: { enabled: true, available: true, generation: 1, sessionId: packet.sessionId },
      request,
    },
    new AbortController().signal,
  );
  await context.prepareTaskContext('fixture');
  expect(context.buildMemoryInput().length).toBeLessThan(ContextLimits.PACKET_CHARACTERS + 500);
  expect(source.text).toHaveLength(32000);
  expect(packet.checkpoint.claims).toHaveLength(16);
});

it('projects question-relevant source ranges past the old prefix boundary and preserves exact source identity', async () => {
  const packet = createPacket();
  const source = packet.sources[0];
  if (!source) {
    throw new Error('Missing source fixture.');
  }
  source.text = `${'Unrelated screen panel. '.repeat(150)}\nTypeError: unsupported operand when adding text to the score. REQUIRED_SCORE_TYPE_ERROR`;
  const originalText = source.text;
  const request = vi
    .fn<TaskContextPort['request']>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'resolve' ? { kind: 'packet', packet } : { kind: 'accepted', revision: 1 },
      ),
    );
  const context = new PreparedTaskContext(
    {
      scope: { enabled: true, available: true, generation: 1, sessionId: packet.sessionId },
      request,
    },
    new AbortController().signal,
  );
  await context.prepareForQuestion('Why does adding to my score produce a TypeError?');
  const input = context.buildMemoryInput();
  expect(input).toContain('REQUIRED_SCORE_TYPE_ERROR');
  expect(input).toContain(source.id);
  expect(input).toContain('"offset":');
  expect(input).toContain('"originalCharacters":');
  expect(input.length).toBeLessThan(ContextLimits.PACKET_CHARACTERS + 500);
  expect(source.text).toBe(originalText);
  expect(request.mock.calls.map(([command]) => command.kind)).toEqual(['events', 'resolve']);
});
