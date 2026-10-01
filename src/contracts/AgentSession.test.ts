import { describe, expect, it } from 'vitest';
import { AgentCommandSchema, AgentResultSchema, AgentWorkerRequestSchema } from './AgentSession.js';
import { DesktopLocale } from './DesktopLocale.js';

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
      expect(AgentCommandSchema.parse(command)).toEqual(command);
      expect(AgentWorkerRequestSchema.parse({ requestId: sessionId, command }).command).toEqual(
        command,
      );
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
