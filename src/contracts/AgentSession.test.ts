import { describe, expect, it } from 'vitest';
import { AgentCommandSchema, AgentResultSchema, AgentWorkerRequestSchema } from './AgentSession.js';

const sessionId = 'cb30eac4-48cb-4ed9-bc0b-8928a4de66b3';

describe('agent IPC contract', () => {
  it('accepts a bounded chat turn and rejects empty or oversized messages', () => {
    expect(
      AgentCommandSchema.safeParse({ kind: 'turn', sessionId, message: 'What is on screen?' })
        .success,
    ).toBe(true);
    expect(AgentCommandSchema.safeParse({ kind: 'turn', sessionId, message: ' ' }).success).toBe(
      false,
    );
    expect(
      AgentCommandSchema.safeParse({ kind: 'turn', sessionId, message: 'a'.repeat(8001) }).success,
    ).toBe(false);
  });

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
