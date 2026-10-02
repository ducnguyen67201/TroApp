import { describe, expect, it } from 'vitest';
import { AgentCommandSchema, AgentResultSchema, AgentWorkerRequestSchema } from './AgentSession.js';
import { DesktopLocale } from './DesktopLocale.js';
import { AgentTaskMode } from './CursorCompanion.js';

const sessionId = 'cb30eac4-48cb-4ed9-bc0b-8928a4de66b3';

describe('agent IPC contract', () => {
  it('accepts a bounded chat turn and rejects empty or oversized messages', () => {
    expect(
      AgentCommandSchema.safeParse({
        kind: 'turn',
        sessionId,
        message: 'What is on screen?',
        locale: DesktopLocale.ENGLISH,
      }).success,
    ).toBe(true);
    expect(
      AgentCommandSchema.safeParse({
        kind: 'turn',
        sessionId,
        message: ' ',
        locale: DesktopLocale.ENGLISH,
      }).success,
    ).toBe(false);
    expect(
      AgentCommandSchema.safeParse({
        kind: 'turn',
        sessionId,
        message: 'a'.repeat(8001),
        locale: DesktopLocale.ENGLISH,
      }).success,
    ).toBe(false);
  });

  it.each([DesktopLocale.ENGLISH, DesktopLocale.VIETNAMESE])(
    'carries the existing %s locale through renderer and worker turns',
    (locale) => {
      const command = { kind: 'turn', sessionId, message: 'Open YouTube', locale };
      expect(AgentCommandSchema.parse(command)).toEqual({
        ...command,
        mode: AgentTaskMode.EXECUTE,
      });
      expect(AgentWorkerRequestSchema.parse({ requestId: sessionId, command }).command).toEqual({
        ...command,
        mode: AgentTaskMode.EXECUTE,
      });
    },
  );

  it.each([undefined, 'fr', 'Vietnamese'])(
    'rejects missing or unsupported locale %s at both IPC boundaries',
    (locale) => {
      const command = { kind: 'turn', sessionId, message: 'Open YouTube', locale };
      expect(AgentCommandSchema.safeParse(command).success).toBe(false);
      expect(AgentWorkerRequestSchema.safeParse({ requestId: sessionId, command }).success).toBe(
        false,
      );
    },
  );

  it('does not accept arbitrary worker commands or screenshots in renderer results', () => {
    expect(
      AgentWorkerRequestSchema.safeParse({
        requestId: sessionId,
        command: { kind: 'click', x: 1, y: 2 },
      }).success,
    ).toBe(false);
    expect(
      AgentResultSchema.safeParse({
        kind: 'completed',
        completion: { kind: 'response' },
        answer: 'Look at the selected tab.',
        screenshot: 'data:image/png;base64,...',
      }).success,
    ).toBe(false);
  });

  it('does not send saved history to the worker when starting a fresh task', () => {
    expect(
      AgentWorkerRequestSchema.safeParse({
        requestId: sessionId,
        command: {
          kind: 'start',
          sessionId,
          gatewayToken: 'scoped-test-token',
          gatewayBaseUrl: 'https://api.example.test/api/v1/model',
          debugEnabled: true,
          desktopDriver: {
            command: '/tro/cua-driver',
            args: ['mcp', '--socket', '/private/tro.sock'],
            env: { CUA_DRIVER_EMBEDDED: '1' },
          },
          history: [{ role: 'user', text: 'Previous task' }],
        },
      }).success,
    ).toBe(false);
  });

  it('requires an explicit boolean for development-only worker diagnostics', () => {
    const command = {
      kind: 'start',
      sessionId,
      gatewayToken: 'scoped-test-token',
      gatewayBaseUrl: 'https://api.example.test/api/v1/model',
      debugEnabled: true,
      desktopDriver: {
        command: '/tro/cua-driver',
        args: ['mcp', '--socket', '/private/tro.sock'],
        env: { CUA_DRIVER_EMBEDDED: '1' },
      },
    };
    expect(AgentWorkerRequestSchema.safeParse({ requestId: sessionId, command }).success).toBe(
      true,
    );
    expect(
      AgentWorkerRequestSchema.safeParse({
        requestId: sessionId,
        command: { ...command, debugEnabled: 'true' },
      }).success,
    ).toBe(false);
  });
});

// Task modes cross the same validated IPC boundary as the message.
it.each([AgentTaskMode.TEACH, AgentTaskMode.EXECUTE])(
  'carries %s mode with locale through both turn boundaries',
  (mode) => {
    const command = {
      kind: 'turn',
      sessionId,
      message: 'Show me',
      locale: DesktopLocale.VIETNAMESE,
      mode,
    };
    expect(AgentCommandSchema.parse(command)).toEqual(command);
    expect(AgentWorkerRequestSchema.parse({ requestId: sessionId, command }).command).toEqual(
      command,
    );
  },
);

it('rejects an unrecognized mode and defaults old clients to execution', () => {
  expect(
    AgentCommandSchema.safeParse({
      kind: 'turn',
      sessionId,
      message: 'Show me',
      locale: DesktopLocale.ENGLISH,
      mode: 'unknown',
    }).success,
  ).toBe(false);
  expect(
    AgentCommandSchema.parse({
      kind: 'turn',
      sessionId,
      message: 'Help',
      locale: DesktopLocale.ENGLISH,
    }),
  ).toMatchObject({
    mode: 'execute',
  });
});

it('admits only local follow startup without credentials or arbitrary actions', () => {
  expect(AgentCommandSchema.parse({ kind: 'follow' })).toEqual({ kind: 'follow' });
  expect(
    AgentWorkerRequestSchema.safeParse({
      requestId: sessionId,
      command: {
        kind: 'follow',
        sessionId,
        debugEnabled: true,
        desktopDriver: { command: '/tro/cua-driver', args: ['mcp', '--embedded'], env: {} },
      },
    }).success,
  ).toBe(true);
  expect(AgentCommandSchema.safeParse({ kind: 'follow', action: 'click' }).success).toBe(false);
  expect(
    AgentWorkerRequestSchema.safeParse({
      requestId: sessionId,
      command: {
        kind: 'follow',
        sessionId,
        debugEnabled: true,
        gatewayToken: 'unexpected-token',
        desktopDriver: { command: '/tro/cua-driver', args: ['mcp', '--embedded'], env: {} },
      },
    }).success,
  ).toBe(false);
});

it('requires the host-owned endpoint for companion startup and hides it from renderer commands', () => {
  const command = { kind: 'follow', sessionId, debugEnabled: true };
  expect(AgentWorkerRequestSchema.safeParse({ requestId: sessionId, command }).success).toBe(false);
  expect(
    AgentCommandSchema.safeParse({
      kind: 'follow',
      desktopDriver: { command: '/driver', args: [], env: {} },
    }).success,
  ).toBe(false);
});

it('keeps the HUD group private while both workers receive the embedded endpoint', () => {
  const command = {
    kind: 'follow',
    sessionId,
    debugEnabled: false,
    hudGroup: sessionId,
    desktopDriver: { command: '/tro/cua-driver', args: ['mcp', '--embedded'], env: {} },
  };
  expect(AgentWorkerRequestSchema.parse({ requestId: sessionId, command }).command).toEqual(
    command,
  );
  expect(AgentCommandSchema.safeParse({ kind: 'follow', hudGroup: sessionId }).success).toBe(false);
  expect(
    AgentWorkerRequestSchema.safeParse({
      requestId: sessionId,
      command: { ...command, hudGroup: 'bad' },
    }).success,
  ).toBe(false);
});
