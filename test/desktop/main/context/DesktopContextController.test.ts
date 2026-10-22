import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextOutbox } from '../../../../src/desktop/main/context/ContextOutbox.js';
import { ContextPreferences } from '../../../../src/desktop/main/context/ContextPreferences.js';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  DesktopContextController,
  type ContextCollector,
} from '../../../../src/desktop/main/context/DesktopContextController.js';
import type { ContextApiClient } from '../../../../src/desktop/main/context/ContextApiClient.js';
import {
  ContextEventKind,
  ContextFailure,
  type ContextEvent,
  type ContextReply,
} from '../../../../src/contracts/StudyContext.js';

it('starts automatically and cancels/fences an in-flight request when switched off', async () => {
  let enabled = true;
  let generation = 0;
  let finish: (reply: ContextReply) => void = () => {};
  const pending = new Promise<ContextReply>((resolve) => {
    finish = resolve;
  });
  const execute = vi.fn<ContextApiClient['execute']>().mockImplementation(async (command) => {
    if (command.kind === 'resolve') {
      return pending;
    }
    if (command.kind === 'set-enabled') {
      enabled = command.enabled;
      generation += 1;
    }
    return {
      kind: 'preferences',
      preference: {
        enabled,
        available: true,
        generation,
        sessionId: 'ec1c9efc-3fc9-4a37-8abf-5fc099dc39c2',
      },
    };
  });
  const start = vi.fn<ContextCollector['start']>().mockResolvedValue();
  const stop = vi.fn<ContextCollector['stop']>().mockResolvedValue();
  const collector: ContextCollector = { start, stop };
  const cancel = vi.fn<() => void>();
  const controller = new DesktopContextController({ execute }, collector, cancel);
  await controller.setAccount('student');
  expect(controller.readScope()?.enabled).toBe(true);
  expect(start).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledTimes(1);
  const request = controller.execute({ kind: 'resolve', generation: 0, query: '', cursor: null });
  await controller.control({ kind: 'set-enabled', enabled: false });
  finish({ kind: 'accepted', revision: 1 });
  expect(await request).toEqual({ kind: 'failed', code: ContextFailure.STALE });
  expect(controller.readScope()).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalled();
});

it('keeps the collector stopped during lock and account transitions', async () => {
  const execute = vi.fn<ContextApiClient['execute']>().mockResolvedValue({
    kind: 'preferences',
    preference: { enabled: true, available: true, generation: 1, sessionId: randomUUID() },
  });
  const start = vi.fn<ContextCollector['start']>().mockResolvedValue();
  const stop = vi.fn<ContextCollector['stop']>().mockResolvedValue();
  const collector: ContextCollector = { start, stop };
  const controller = new DesktopContextController({ execute }, collector, () => {});
  await controller.setAccount('student');
  await controller.control({ kind: 'set-enabled', enabled: true });
  await controller.suspend();
  const starts = start.mock.calls.length;
  await controller.resume();
  expect(start).toHaveBeenCalledTimes(starts);
  await controller.wake();
  expect(start).toHaveBeenCalledTimes(starts + 1);
  controller.clear();
  expect(controller.readScope()).toBeNull();
  expect(await controller.control({ kind: 'preferences' })).toEqual({
    kind: 'failed',
    code: ContextFailure.UNAUTHORIZED,
  });
});

it('drains already observed input before yielding capture to a task', async () => {
  let receive: (events: ContextEvent[]) => void = () => {};
  const execute = vi.fn<ContextApiClient['execute']>().mockImplementation((command) =>
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
  const collector: ContextCollector = {
    start: (listener) => {
      receive = listener;
      return Promise.resolve();
    },
    stop: (flush) => {
      if (flush) {
        receive([
          {
            id: randomUUID(),
            kind: ContextEventKind.INPUT,
            resource: 'physical-input',
            observedAt: new Date().toISOString(),
            text: 'release with unknown target',
            limitation: 'Attempt only',
          },
        ]);
      }
      return Promise.resolve();
    },
  };
  const controller = new DesktopContextController({ execute }, collector, () => {});
  await controller.setAccount('student');
  await controller.control({ kind: 'set-enabled', enabled: true });
  await controller.pause();
  expect(execute.mock.calls.filter(([command]) => command.kind === 'events')).toHaveLength(1);
});

it('does not disable enrichment or cancel help for a checkpoint revision conflict', async () => {
  const cancel = vi.fn<() => void>();
  const execute = vi.fn<ContextApiClient['execute']>().mockImplementation((command) =>
    Promise.resolve(
      command.kind === 'checkpoint'
        ? { kind: 'failed', code: ContextFailure.REVISION_CONFLICT }
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
  const collector: ContextCollector = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  const controller = new DesktopContextController({ execute }, collector, cancel);
  await controller.setAccount('student');
  await controller.control({ kind: 'set-enabled', enabled: true });
  const reply = await controller.execute({
    kind: 'checkpoint',
    generation: 1,
    updateId: randomUUID(),
    update: {
      expectedRevision: 0,
      coveredEventRevision: 1,
      sourceIds: [randomUUID()],
      summary: 'fixture',
      claims: [],
      openQuestions: [],
    },
  });
  expect(reply).toEqual({ kind: 'failed', code: ContextFailure.REVISION_CONFLICT });
  expect(controller.readScope()?.enabled).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
});

it('preserves a local opt-out across startup even when the server preference is enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-context-preference-'));
  try {
    const preferences = new ContextPreferences(directory);
    await preferences.save('student', false);
    const execute = vi.fn<ContextApiClient['execute']>().mockResolvedValue({
      kind: 'preferences',
      preference: { enabled: true, available: true, generation: 0, sessionId: randomUUID() },
    });
    const start = vi.fn<ContextCollector['start']>().mockResolvedValue();
    const stop = vi.fn<ContextCollector['stop']>().mockResolvedValue();
    const controller = new DesktopContextController(
      { execute },
      { start, stop },
      () => {},
      undefined,
      preferences,
    );
    await controller.setAccount('student');
    expect(controller.readScope()).toBeNull();
    expect(start).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves a server opt-out when no local preference has been saved', async () => {
  const execute = vi.fn<ContextApiClient['execute']>().mockResolvedValue({
    kind: 'preferences',
    preference: { enabled: false, available: true, generation: 1, sessionId: randomUUID() },
  });
  const start = vi.fn<ContextCollector['start']>().mockResolvedValue();
  const stop = vi.fn<ContextCollector['stop']>().mockResolvedValue();
  const controller = new DesktopContextController({ execute }, { start, stop }, () => {});
  await controller.setAccount('student');
  expect(controller.readScope()).toBeNull();
  expect(start).not.toHaveBeenCalled();
});

it('reports a rejected capture batch without logging source text or account identity', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    let receive: (events: ContextEvent[]) => void = () => {};
    const execute = vi.fn<ContextApiClient['execute']>().mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'events'
          ? { kind: 'failed', code: ContextFailure.UNAVAILABLE }
          : {
              kind: 'preferences',
              preference: {
                enabled: true,
                available: true,
                generation: 0,
                sessionId: randomUUID(),
              },
            },
      ),
    );
    const collector: ContextCollector = {
      start: (listener) => {
        receive = listener;
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
    };
    const controller = new DesktopContextController({ execute }, collector, () => {});
    await controller.setAccount('private-student-id');
    expect(info).toHaveBeenCalledWith('context.account.resolved', {
      reply: 'preferences',
      code: undefined,
      enabled: true,
      localOptOut: false,
    });
    receive([
      {
        id: randomUUID(),
        kind: ContextEventKind.INPUT,
        resource: 'physical-input',
        observedAt: new Date().toISOString(),
        text: 'private-screen-content',
        limitation: 'Unknown target',
      },
    ]);
    await controller.pause();
    expect(warn).toHaveBeenCalledWith('context.events.rejected', {
      count: 1,
      reply: 'failed',
      code: ContextFailure.UNAVAILABLE,
    });
    const diagnostics = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(diagnostics).not.toContain('private-screen-content');
    expect(diagnostics).not.toContain('private-student-id');
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
});

function createLocalJournalFixture(): {
  journal: Pick<ContextOutbox, 'save' | 'readPending' | 'acknowledge' | 'forget'>;
  save: ReturnType<typeof vi.fn<ContextOutbox['save']>>;
  acknowledged: string[];
} {
  const entries: { name: string; events: ContextEvent[] }[] = [];
  const acknowledged: string[] = [];
  const save = vi.fn<ContextOutbox['save']>().mockImplementation((_owner, _generation, events) => {
    const name = `segment-${String(entries.length)}`;
    entries.push({ name, events });
    return Promise.resolve(name);
  });
  return {
    save,
    acknowledged,
    journal: {
      save,
      readPending: () =>
        Promise.resolve({
          entries: entries.filter((entry) => !acknowledged.includes(entry.name)),
          omittedEntries: 0,
        }),
      acknowledge: (names) => {
        acknowledged.push(...names);
        return Promise.resolve();
      },
      forget: () => {
        entries.length = 0;
        return Promise.resolve();
      },
    },
  };
}

function createCapturedInput(): ContextEvent {
  return {
    id: randomUUID(),
    kind: ContextEventKind.INPUT,
    resource: 'physical-input',
    observedAt: new Date().toISOString(),
    text: JSON.stringify({ kind: 'release', point: { x: 0.5, y: 0.5 } }),
    limitation: 'Target unknown',
  };
}

it('keeps background events local and uploads one compact snapshot only at Ask', async () => {
  const local = createLocalJournalFixture();
  let receive: (events: ContextEvent[]) => void = () => {};
  const execute = vi.fn<ContextApiClient['execute']>().mockImplementation((command) =>
    Promise.resolve(
      command.kind === 'events'
        ? { kind: 'accepted', revision: 1 }
        : {
            kind: 'preferences',
            preference: {
              enabled: true,
              available: true,
              generation: 0,
              sessionId: 'ec1c9efc-3fc9-4a37-8abf-5fc099dc39c2',
            },
          },
    ),
  );
  const collector: ContextCollector = {
    start: (listener) => {
      receive = listener;
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
  const controller = new DesktopContextController({ execute }, collector, () => {}, local.journal);
  await controller.setAccount('student');
  for (let batch = 0; batch < 10; batch += 1) {
    receive(Array.from({ length: 20 }, createCapturedInput));
  }
  await vi.waitFor(() => {
    expect(local.save).toHaveBeenCalledTimes(10);
  });
  expect(execute.mock.calls.filter(([command]) => command.kind === 'events')).toHaveLength(0);
  await controller.pause();
  const uploads = execute.mock.calls
    .map(([command]) => command)
    .filter((command) => command.kind === 'events');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.events).toHaveLength(1);
  expect(uploads[0]?.events[0]?.text).toContain('"eventCount":200');
  expect(local.acknowledged).toHaveLength(10);
  await controller.resume();
  await controller.suspend();
  await controller.wake();
  await controller.pause();
  expect(execute.mock.calls.filter(([command]) => command.kind === 'events')).toHaveLength(1);
});

it('waits for local writes before ingesting the Ask snapshot', async () => {
  const local = createLocalJournalFixture();
  let completeSave: (name: string) => void = () => {};
  const pendingSave = new Promise<string>((resolve) => {
    completeSave = resolve;
  });
  local.save.mockReturnValueOnce(pendingSave);
  let receive: (events: ContextEvent[]) => void = () => {};
  const execute = vi.fn<ContextApiClient['execute']>().mockResolvedValue({
    kind: 'preferences',
    preference: { enabled: true, available: true, generation: 0, sessionId: randomUUID() },
  });
  const collector: ContextCollector = {
    start: (listener) => {
      receive = listener;
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
  const controller = new DesktopContextController({ execute }, collector, () => {}, local.journal);
  await controller.setAccount('student');
  receive([createCapturedInput()]);
  const asking = controller.pause();
  await vi.waitFor(() => {
    expect(local.save).toHaveBeenCalledOnce();
  });
  expect(execute).toHaveBeenCalledTimes(1);
  completeSave('completed');
  await asking;
});

it('retries the same snapshot after an ambiguous upload while newer activity stays local', async () => {
  const local = createLocalJournalFixture();
  let receive: (events: ContextEvent[]) => void = () => {};
  let attempts = 0;
  const execute = vi.fn<ContextApiClient['execute']>().mockImplementation((command) => {
    if (command.kind === 'events') {
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? { kind: 'failed', code: ContextFailure.UNAVAILABLE }
          : { kind: 'accepted', revision: 1 },
      );
    }
    return Promise.resolve({
      kind: 'preferences',
      preference: {
        enabled: true,
        available: true,
        generation: 0,
        sessionId: 'ec1c9efc-3fc9-4a37-8abf-5fc099dc39c2',
      },
    });
  });
  const collector: ContextCollector = {
    start: (listener) => {
      receive = listener;
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
  const controller = new DesktopContextController({ execute }, collector, () => {}, local.journal);
  await controller.setAccount('student');
  receive([createCapturedInput()]);
  await controller.pause();
  expect(local.acknowledged).toHaveLength(0);
  await controller.resume();
  receive([createCapturedInput()]);
  await controller.pause();
  const uploads = execute.mock.calls
    .map(([command]) => command)
    .filter((command) => command.kind === 'events');
  expect(uploads).toHaveLength(2);
  expect(uploads[1]?.events).toEqual(uploads[0]?.events);
  expect(local.acknowledged).toEqual(['segment-0']);
});

it('ingests transient memory at Ask when protected local storage cannot be read or written', async () => {
  const local = createLocalJournalFixture();
  local.save.mockRejectedValue(new Error('Protected storage unavailable'));
  local.journal.readPending = () => Promise.reject(new Error('Protected storage unavailable'));
  let receive: (events: ContextEvent[]) => void = () => {};
  const execute = vi.fn<ContextApiClient['execute']>().mockImplementation((command) =>
    Promise.resolve(
      command.kind === 'events'
        ? { kind: 'accepted', revision: 1 }
        : {
            kind: 'preferences',
            preference: {
              enabled: true,
              available: true,
              generation: 0,
              sessionId: 'ec1c9efc-3fc9-4a37-8abf-5fc099dc39c2',
            },
          },
    ),
  );
  const collector: ContextCollector = {
    start: (listener) => {
      receive = listener;
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
  const controller = new DesktopContextController({ execute }, collector, () => {}, local.journal);
  await controller.setAccount('student');
  receive([createCapturedInput()]);
  await controller.pause();
  const uploads = execute.mock.calls
    .map(([command]) => command)
    .filter((command) => command.kind === 'events');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.events[0]?.text).toContain('"eventCount":1');
});

it('clears transient capture and a failed snapshot when the user disables and reenables context', async () => {
  let receive: (events: ContextEvent[]) => void = () => {};
  let enabled = true;
  let generation = 0;
  const execute = vi.fn<ContextApiClient['execute']>().mockImplementation((command) => {
    if (command.kind === 'events') {
      return Promise.resolve({ kind: 'failed', code: ContextFailure.UNAVAILABLE });
    }
    if (command.kind === 'set-enabled') {
      enabled = command.enabled;
      generation += 1;
    }
    return Promise.resolve({
      kind: 'preferences',
      preference: {
        enabled,
        available: true,
        generation,
        sessionId: 'ec1c9efc-3fc9-4a37-8abf-5fc099dc39c2',
      },
    });
  });
  const collector: ContextCollector = {
    start: (listener) => {
      receive = listener;
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
  const controller = new DesktopContextController({ execute }, collector, () => {});
  await controller.setAccount('student');
  receive([createCapturedInput()]);
  await controller.pause();
  await controller.control({ kind: 'set-enabled', enabled: false });
  await controller.control({ kind: 'set-enabled', enabled: true });
  await controller.pause();
  expect(execute.mock.calls.filter(([command]) => command.kind === 'events')).toHaveLength(1);
});
