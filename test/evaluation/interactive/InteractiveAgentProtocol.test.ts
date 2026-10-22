import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AgentTaskMode } from '../../../src/contracts/CursorCompanion.js';
import { DesktopLocale } from '../../../src/contracts/DesktopLocale.js';
import {
  InteractiveAgentRunSchema,
  InteractiveAgentResponseSchema,
  InteractiveGatewayUrlSchema,
  InteractiveModelRequestSchema,
} from './InteractiveAgentProtocol.js';

it('validates the private run contract and defaults to production execution mode', () => {
  const parsed = InteractiveAgentRunSchema.parse({
    kind: 'run',
    trialId: randomUUID(),
    desktopDriver: { command: 'native-driver', args: [], env: {} },
    credential: {
      token: 'test-short-lived',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    gatewayBaseUrl: 'http://127.0.0.1:3000/api/v1/model',
    request: 'Click the blue Start button.',
    historyText: 'Authored prior activity.',
    contextEnabled: true,
  });
  expect(parsed.taskMode).toBe(AgentTaskMode.EXECUTE);
  expect(parsed.locale).toBe(DesktopLocale.ENGLISH);
  expect(
    InteractiveAgentRunSchema.parse({ ...parsed, locale: DesktopLocale.VIETNAMESE }).locale,
  ).toBe(DesktopLocale.VIETNAMESE);
  expect(
    InteractiveAgentRunSchema.parse({ ...parsed, taskMode: AgentTaskMode.TEACH }).taskMode,
  ).toBe(AgentTaskMode.TEACH);
});

it('accepts legacy request accounting and optional provider detail without inventing missing values', () => {
  const request = {
    id: randomUUID(),
    status: 200,
    durationMs: 120,
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
  };
  expect(InteractiveModelRequestSchema.parse(request)).toEqual(request);
  expect(
    InteractiveModelRequestSchema.parse({
      ...request,
      model: 'gpt-6.1-sol',
      cacheWriteInputTokens: 5,
      reasoningTokens: 12,
    }),
  ).toMatchObject({ model: 'gpt-6.1-sol', cacheWriteInputTokens: 5, reasoningTokens: 12 });
});

it('rejects impossible subsets and arbitrary model text at the accounting boundary', () => {
  const request = {
    id: randomUUID(),
    status: 200,
    durationMs: 120,
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
  };
  for (const detail of [
    { cacheWriteInputTokens: 91 },
    { reasoningTokens: 21 },
    { model: 'private model text\n' },
  ]) {
    expect(InteractiveModelRequestSchema.safeParse({ ...request, ...detail }).success).toBe(false);
  }
});

it.each([
  'http://public.example.test/api/v1/model',
  'https://user:password@example.test/model',
  'https://example.test/model?token=secret',
  'https://example.test/model#credential',
  'file:///private/credential',
])('rejects unsafe credential gateway URLs: %s', (url) => {
  expect(InteractiveGatewayUrlSchema.safeParse(url).success).toBe(false);
});

it('keeps a cue-installed acknowledgment distinct from a settled task', () => {
  const trialId = randomUUID();
  const message = InteractiveAgentResponseSchema.parse({
    kind: 'cue-installed',
    trialId,
    elapsedMs: 123,
  });
  expect(message.kind).toBe('cue-installed');
  expect(
    InteractiveAgentResponseSchema.safeParse({ kind: 'cue-installed', trialId, elapsedMs: -1 })
      .success,
  ).toBe(false);
});

it('rejects native arguments, raw SDK history and unbounded public outputs at the recording boundary', () => {
  const event = {
    kind: 'output',
    trialId: randomUUID(),
    sequence: 1,
    elapsedMs: 10,
    output: {
      kind: 'native_tool',
      stage: 'request',
      toolName: 'get_desktop_state',
      callId: null,
      isMutation: false,
      durationMs: null,
      isError: null,
    },
  };
  expect(InteractiveAgentResponseSchema.safeParse(event).success).toBe(true);
  expect(
    InteractiveAgentResponseSchema.safeParse({
      ...event,
      output: { ...event.output, arguments: { screenshot: 'pixels' } },
    }).success,
  ).toBe(false);
  expect(InteractiveAgentResponseSchema.safeParse({ ...event, history: [] }).success).toBe(false);
  expect(InteractiveAgentResponseSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
});
