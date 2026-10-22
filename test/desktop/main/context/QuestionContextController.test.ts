import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ContextOutbox } from '../../../../src/desktop/main/context/ContextOutbox.js';
import {
  DesktopContextController,
  type ContextCollector,
} from '../../../../src/desktop/main/context/DesktopContextController.js';
import type { ContextApiClient } from '../../../../src/desktop/main/context/ContextApiClient.js';
import { ContextEventKind, ContextFailure, type ContextEvent } from '#contracts/StudyContext.js';

function createObservation(text: string, minutesAgo: number): ContextEvent {
  return {
    id: randomUUID(),
    kind: ContextEventKind.OBSERVATION,
    resource: 'synthetic-study-workspace',
    observedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    text,
    limitation: 'Authored evidence; application acceptance and learning are unknown.',
  };
}

function createApi() {
  return vi.fn<ContextApiClient['execute']>().mockImplementation((command) =>
    Promise.resolve(
      command.kind === 'events'
        ? { kind: 'accepted', revision: 1 }
        : {
            kind: 'preferences',
            preference: {
              enabled: true,
              available: true,
              generation: 1,
              sessionId: 'ec1c9efc-3fc9-4a37-8abf-5fc099dc39c2',
            },
          },
    ),
  );
}

const collector: ContextCollector = {
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};

it('ingests relevant older evidence for different questions without consuming raw upload receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroQuestionContext-'));
  try {
    const outbox = new ContextOutbox(
      directory,
      (text) => Buffer.from(text, 'utf8'),
      (bytes) => bytes.toString('utf8'),
    );
    await outbox.save('student', 1, [
      createObservation('Assignment: repeat the movement seven times. REQUIRED_ASSIGNMENT', 170),
    ]);
    await outbox.save('student', 1, [
      createObservation('TypeError: cannot add text to the score. REQUIRED_TYPE_ERROR', 100),
    ]);
    for (let index = 0; index < 75; index += 1) {
      await outbox.save('student', 1, [
        createObservation(`Unrelated preview panel ${String(index)}.`, 50 - index / 2),
      ]);
    }
    const frozen = await outbox.readPending('student', 1);
    await outbox.acknowledge(frozen.entries.map((entry) => entry.name));
    const acknowledge = vi.spyOn(outbox, 'acknowledge');
    const execute = createApi();
    const controller = new DesktopContextController({ execute }, collector, () => {}, outbox);
    await controller.setAccount('student');
    await controller.pause('What did the assignment require me to repeat?');
    await controller.pause('Why does adding to the score produce a TypeError?');
    await controller.pause('What did the assignment require me to repeat?');
    const uploads = execute.mock.calls
      .map(([command]) => command)
      .filter((command) => command.kind === 'events');
    expect(uploads).toHaveLength(3);
    expect(JSON.stringify(uploads[0])).toContain('REQUIRED_ASSIGNMENT');
    expect(JSON.stringify(uploads[1])).toContain('REQUIRED_TYPE_ERROR');
    expect(uploads[2]?.events.map((event) => event.text)).toEqual(
      uploads[0]?.events.map((event) => event.text),
    );
    expect(uploads[2]?.events.map((event) => event.id)).not.toEqual(
      uploads[0]?.events.map((event) => event.id),
    );
    expect(uploads.every((upload) => upload.events.length <= 6)).toBe(true);
    expect(acknowledge).not.toHaveBeenCalled();
    expect((await outbox.readSession('student', 1)).events).toHaveLength(77);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not upload a retained session result that arrives after an account switch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroQuestionContext-'));
  try {
    const outbox = new ContextOutbox(
      directory,
      (text) => Buffer.from(text, 'utf8'),
      (bytes) => bytes.toString('utf8'),
    );
    await outbox.save('student', 1, [createObservation('Assignment: keep this owner private.', 1)]);
    const captured = await outbox.readSession('student', 1);
    let finish: (result: typeof captured) => void = () => {};
    const readSession = vi.spyOn(outbox, 'readSession').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const execute = createApi();
    const controller = new DesktopContextController({ execute }, collector, () => {}, outbox);
    await controller.setAccount('student');
    const asking = controller.pause('What was the assignment?');
    await vi.waitFor(() => {
      expect(readSession).toHaveBeenCalledOnce();
    });
    await controller.setAccount('other');
    finish(captured);
    await asking;
    expect(execute.mock.calls.filter(([command]) => command.kind === 'events')).toHaveLength(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('fences an old Ask before collector shutdown completes during an account switch', async () => {
  let finishStop = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  const stop = vi
    .fn<ContextCollector['stop']>()
    .mockImplementation((flush) => (flush ? stopped : Promise.resolve()));
  const execute = createApi();
  const controller = new DesktopContextController(
    { execute },
    { start: () => Promise.resolve(), stop },
    () => {},
  );
  await controller.setAccount('student');
  const asking = controller.pause('What was my assignment?');
  await controller.setAccount('other');
  finishStop();
  await asking;
  expect(execute.mock.calls.filter(([command]) => command.kind === 'events')).toHaveLength(0);
});

it('keeps memory fallback searchable when protected journal reads fail', async () => {
  let receive: (events: ContextEvent[]) => void = () => {};
  const memoryCollector: ContextCollector = {
    start: (listener) => {
      receive = listener;
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
  const outbox = {
    save: vi.fn<ContextOutbox['save']>().mockRejectedValue(new Error('Storage unavailable')),
    readPending: vi
      .fn<ContextOutbox['readPending']>()
      .mockResolvedValue({ entries: [], omittedEntries: 0 }),
    readSession: vi
      .fn<ContextOutbox['readSession']>()
      .mockRejectedValue(new Error('Storage unavailable')),
    acknowledge: vi.fn<ContextOutbox['acknowledge']>().mockResolvedValue(),
    forget: vi.fn<ContextOutbox['forget']>().mockResolvedValue(),
  };
  const execute = createApi();
  const controller = new DesktopContextController({ execute }, memoryCollector, () => {}, outbox);
  await controller.setAccount('student');
  receive([createObservation('Assignment: repeat seven times. MEMORY_ASSIGNMENT', 1)]);
  await controller.pause('What should I repeat?');
  await controller.pause('Remind me of the assignment.');
  const uploads = execute.mock.calls
    .map(([command]) => command)
    .filter((command) => command.kind === 'events');
  expect(uploads).toHaveLength(2);
  expect(
    uploads.every((command) => JSON.stringify(command.events).includes('MEMORY_ASSIGNMENT')),
  ).toBe(true);
  expect(controller.readScope()?.enabled).toBe(true);
  expect(
    await controller.execute({ kind: 'resolve', generation: 2, query: 'assignment', cursor: null }),
  ).toEqual({ kind: 'failed', code: ContextFailure.DISABLED });
});
