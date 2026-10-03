import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatController } from '../../../src/desktop/main/AgentChatController.js';
import {
  executeAgentCommand,
  type AgentCommandPorts,
} from '../../../src/desktop/main/ExecuteAgentCommand.js';
import type { AgentChatWorker } from '../../../src/desktop/main/AgentChatPorts.js';

function createPorts() {
  const worker = {
    isRunning: () => false,
    startCompanion: vi.fn<AgentChatWorker['startCompanion']>(),
    start: vi
      .fn<AgentChatWorker['start']>()
      .mockImplementation((sessionId) => Promise.resolve({ kind: 'started', sessionId })),
    sendMessage: vi.fn<AgentChatWorker['sendMessage']>().mockResolvedValue({
      kind: 'teaching',
      result: { outcome: 'goal_reached', answer: 'YouTube is open.' },
    }),
    stop: vi.fn<AgentChatWorker['stop']>().mockResolvedValue({ kind: 'stopped' }),
    dispose: vi.fn<AgentChatWorker['dispose']>(),
  } satisfies AgentChatWorker;
  const chat = new AgentChatController(
    {
      readSession: () =>
        Promise.resolve({
          kind: 'signed-in',
          user: { id: 'test', name: 'Test', email: 'test@example.test' },
        }),
      signInWithGoogle: () => Promise.resolve({ kind: 'signed-out' }),
      signOut: () => Promise.resolve({ kind: 'signed-out' }),
      fetchModelCredential: () =>
        Promise.resolve({
          token: 'fixture',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
    },
    worker,
    'http://127.0.0.1/v1',
    {
      readStatus: () =>
        Promise.resolve({
          kind: 'ready',
          accessibility: 'granted',
          screenRecording: 'granted',
        }),
    },
  );
  const ports: AgentCommandPorts = {
    chat,
    startFollowing: vi
      .fn<AgentCommandPorts['startFollowing']>()
      .mockResolvedValue({ kind: 'stopped' }),
    canSendMessage: () => true,
    startTask: vi.fn<AgentCommandPorts['startTask']>(),
    finishTask: vi.fn<AgentCommandPorts['finishTask']>(),
    cancelPresentation: vi.fn<AgentCommandPorts['cancelPresentation']>(),
  };
  return { ports, worker };
}

describe('main agent command dispatch', () => {
  it('rejects invalid commands before task presentation or worker startup', async () => {
    const { ports, worker } = createPorts();
    try {
      expect(
        await executeAgentCommand(
          { kind: 'turn', sessionId: 'invalid', message: 'Open YouTube' },
          ports,
        ),
      ).toMatchObject({ kind: 'failed' });
      expect(ports.startTask).not.toHaveBeenCalled();
      expect(worker.start).not.toHaveBeenCalled();
    } finally {
      ports.chat.dispose();
    }
  });

  it('preserves the voice busy gate before admitting a task', async () => {
    const { ports, worker } = createPorts();
    try {
      expect(
        await executeAgentCommand(
          {
            kind: 'turn',
            sessionId: randomUUID(),
            message: 'Open YouTube',
            locale: 'vi',
            mode: 'teach',
          },
          { ...ports, canSendMessage: () => false },
        ),
      ).toMatchObject({ kind: 'failed' });
      expect(ports.startTask).not.toHaveBeenCalled();
      expect(worker.start).not.toHaveBeenCalled();
    } finally {
      ports.chat.dispose();
    }
  });

  it('dispatches teaching mode with presentation and its actual result', async () => {
    const { ports, worker } = createPorts();
    const sessionId = randomUUID();
    try {
      const result = await executeAgentCommand(
        { kind: 'turn', sessionId, message: 'Open YouTube', locale: 'vi', mode: 'teach' },
        ports,
      );
      expect(worker.sendMessage).toHaveBeenCalledWith(sessionId, 'Open YouTube', 'vi', 'teach');
      expect(ports.startTask).toHaveBeenCalledWith(sessionId, 'vi');
      expect(ports.finishTask).toHaveBeenCalledWith(result, sessionId);
      expect(result).toMatchObject({ kind: 'teaching', result: { outcome: 'goal_reached' } });
    } finally {
      ports.chat.dispose();
    }
  });

  it('stops presentation and rejects an answer outside the active lesson', async () => {
    const { ports } = createPorts();
    const sessionId = randomUUID();
    try {
      expect(
        await executeAgentCommand(
          { kind: 'answer', sessionId, lessonId: randomUUID(), message: 'Chrome', locale: 'vi' },
          ports,
        ),
      ).toMatchObject({ kind: 'failed' });
      expect(await executeAgentCommand({ kind: 'stop', sessionId }, ports)).toEqual({
        kind: 'stopped',
      });
      expect(ports.cancelPresentation).toHaveBeenCalledOnce();
    } finally {
      ports.chat.dispose();
    }
  });
});
