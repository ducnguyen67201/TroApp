import { afterEach, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@openai/agents';
import { DesktopObservationTool } from '#contracts/DesktopObservation.js';
import type { CompanionTransport } from '../../../../src/desktop/worker/cua/CuaCompanionClient.js';
import { DesktopObservationClient } from '../../../../src/desktop/worker/observation/DesktopObservationClient.js';
import { describeTeachingFailure } from '../../../../src/desktop/worker/teaching/TeachingFailure.js';

const watchId = '11111111-1111-4111-8111-111111111111';
const observation = {
  watch_id: watchId,
  screen_revision: 3,
  input_revision: 5,
  ready: true,
  changed_fraction: 0.1,
  quiet_ms: 500,
  buttons_down: false,
  screen_width: 1200,
  screen_height: 800,
};
const capture: CallToolResult = {
  content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  structuredContent: { observation },
};

afterEach(() => {
  vi.useRealTimers();
});

it.each<{
  result: CallToolResult;
  expectedCode: string;
  expectedDiagnostics: Record<string, unknown>;
}>([
  {
    result: {
      isError: true,
      content: [{ type: 'text', text: 'watch_lost private native detail' }],
    },
    expectedCode: 'observation_tool_failed',
    expectedDiagnostics: { nativeResult: { reasonCode: 'watch_lost' } },
  },
  {
    result: { content: [], structuredContent: { ...observation, ready: 'private invalid value' } },
    expectedCode: 'observation_invalid_snapshot',
    expectedDiagnostics: { invalidFields: ['ready'] },
  },
  {
    result: {
      content: [],
      structuredContent: { ...observation, watch_id: '22222222-2222-4222-8222-222222222222' },
    },
    expectedCode: 'observation_owner_mismatch',
    expectedDiagnostics: {},
  },
])(
  'preserves specific native watch failure diagnostics: $expectedCode',
  async ({ result, expectedCode, expectedDiagnostics }) => {
    const callHostTool = vi.fn<CompanionTransport['callHostTool']>().mockResolvedValue(result);
    const client = new DesktopObservationClient({ callHostTool });
    let failure: unknown;
    try {
      await client.begin(watchId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: expectedCode, reason: 'session_lost' });
    const diagnostics = describeTeachingFailure(failure);
    expect(diagnostics).toMatchObject({
      errorCode: expectedCode,
      toolName: DesktopObservationTool.BEGIN,
      ...expectedDiagnostics,
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private native detail|private invalid value|11111111|22222222/,
    );
    expect(callHostTool).toHaveBeenLastCalledWith(DesktopObservationTool.END, {
      watch_id: watchId,
    });
  },
);

it('keeps capture-time revisions when a newer change arrives and renews one watch', async () => {
  vi.useFakeTimers();
  const callHostTool = vi
    .fn<CompanionTransport['callHostTool']>()
    .mockResolvedValue({ content: [], structuredContent: observation });
  const client = new DesktopObservationClient({ callHostTool });
  await client.begin(watchId);
  client.recordCapture(capture);
  callHostTool.mockResolvedValue({
    content: [],
    structuredContent: { ...observation, input_revision: 6 },
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect((await client.read()).input_revision).toBe(6);
  expect(client.readBaseline()?.input_revision).toBe(5);
  await client.end();
  const calls = callHostTool.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(callHostTool.mock.calls).toHaveLength(calls);
  expect(callHostTool).toHaveBeenLastCalledWith(DesktopObservationTool.END, { watch_id: watchId });
  expect(client.readBaseline()).toBeNull();
});

it('rejects foreign watch metadata and never treats malformed or missing pixels as evidence', async () => {
  const callHostTool = vi
    .fn<CompanionTransport['callHostTool']>()
    .mockResolvedValue({ content: [], structuredContent: observation });
  const client = new DesktopObservationClient({ callHostTool });
  await client.begin(watchId);
  client.recordCapture({ content: [], structuredContent: { observation } });
  expect(client.readBaseline()).toBeNull();
  client.recordCapture({
    ...capture,
    structuredContent: {
      observation: { ...observation, watch_id: '22222222-2222-4222-8222-222222222222' },
    },
  });
  expect(client.readBaseline()).toBeNull();
  callHostTool.mockResolvedValue({
    content: [],
    structuredContent: { ...observation, watch_id: '22222222-2222-4222-8222-222222222222' },
  });
  await expect(client.read()).rejects.toMatchObject({ reason: 'session_lost' });
  await client.end();
});
