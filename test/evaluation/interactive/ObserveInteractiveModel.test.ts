import { expect, it, vi } from 'vitest';
import { ModelRequestTraceHeader } from '../../../src/contracts/ModelGatewayError.js';
import {
  InteractiveModelObservationLimits,
  InteractiveModelUsageReader,
  observeInteractiveModelFetch,
} from './ObserveInteractiveModel.js';

const encoder = new TextEncoder();

function createCompletedEvent(inputTokens = 120, outputTokens = 14): string {
  return `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: inputTokens, output_tokens: outputTokens, input_tokens_details: { cached_tokens: 40 } } } })}\n\n`;
}

it('ignores created placeholders and reads only validated terminal streaming usage', () => {
  const reader = new InteractiveModelUsageReader('text/event-stream; charset=utf-8');
  reader.accept(
    encoder.encode(
      'data: {"type":"response.created","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
    ),
  );
  expect(reader.readUsage()).toBeNull();
  const terminal = encoder.encode(createCompletedEvent());
  for (let offset = 0; offset < terminal.byteLength; offset += 7) {
    reader.accept(terminal.slice(offset, offset + 7));
  }
  expect(reader.finish()).toEqual({ inputTokens: 120, cachedInputTokens: 40, outputTokens: 14 });
});

it('reads normal JSON usage after chunked UTF-8 content without retaining content in its result', () => {
  const reader = new InteractiveModelUsageReader('application/json');
  const bytes = encoder.encode(
    JSON.stringify({
      output: 'Private response 🦊 must stay out of telemetry.',
      usage: { input_tokens: 75, output_tokens: 8 },
    }),
  );
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    reader.accept(bytes.slice(offset, offset + 2));
  }
  expect(reader.readUsage()).toBeNull();
  expect(reader.finish()).toEqual({ inputTokens: 75, cachedInputTokens: 0, outputTokens: 8 });
  expect(JSON.stringify(reader.readUsage())).not.toContain('Private response');
});

it('skips an oversized streaming line and recovers for a later bounded terminal event', () => {
  const reader = new InteractiveModelUsageReader('text/event-stream');
  reader.accept(
    encoder.encode(
      `data: ${'x'.repeat(InteractiveModelObservationLimits.MAXIMUM_BUFFER_BYTES + 1)}`,
    ),
  );
  reader.accept(encoder.encode(`still oversized\n\n${createCompletedEvent()}`));
  expect(reader.finish()).toEqual({ inputTokens: 120, cachedInputTokens: 40, outputTokens: 14 });
});

it('does not partially parse oversized JSON as known usage', () => {
  const reader = new InteractiveModelUsageReader('application/json');
  reader.accept(
    encoder.encode(
      JSON.stringify({
        content: 'x'.repeat(InteractiveModelObservationLimits.MAXIMUM_BUFFER_BYTES),
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ),
  );
  expect(reader.finish()).toBeNull();
});

it.each([
  { input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 3 } },
  {
    input_tokens: 3,
    output_tokens: 1,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 2 },
  },
  { input_tokens: -1, output_tokens: 1 },
  { input_tokens: 1.5, output_tokens: 1 },
  { output_tokens: 1 },
])('keeps invalid or missing accounting unknown: %j', (usage) => {
  const reader = new InteractiveModelUsageReader('application/json');
  reader.accept(encoder.encode(JSON.stringify({ usage })));
  expect(reader.finish()).toBeNull();
});

it('forwards exact stream bytes and preserves response status and headers while collecting token counts', async () => {
  const source = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'SecretFixtureResponse' })}\n\n${createCompletedEvent()}`;
  const bytes = encoder.encode(source);
  const fetchModel = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, 15));
            controller.enqueue(bytes.slice(15));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream', 'x-fixture': 'kept' } },
      ),
    ),
  );
  const observer = observeInteractiveModelFetch(fetchModel);
  const response = await observer.fetch('https://benchmark.example.test/api/v1/model/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer private-test-credential' },
  });
  expect(response.headers.get('x-fixture')).toBe('kept');
  expect(await response.text()).toBe(source);
  const observed = observer.readRequests();
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({
    status: 200,
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 14,
  });
  expect(JSON.stringify(observed)).not.toContain('SecretFixtureResponse');
  expect(JSON.stringify(observed)).not.toContain('private-test-credential');
  const sent = fetchModel.mock.calls[0];
  if (!sent) {
    throw new Error('The model fetch was not invoked.');
  }
  const headers = new Headers(sent[1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer private-test-credential');
  expect(headers.get(ModelRequestTraceHeader)).toBe(observed[0]?.id);
  expect(sent[1]?.redirect).toBe('error');
});

it('counts HTTP failures and uncertain failed fetches without inventing free token usage', async () => {
  const fetchModel = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response('{"error":"unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )
    .mockRejectedValueOnce(new Error('Private transport details must not enter the report.'));
  const observer = observeInteractiveModelFetch(fetchModel);
  const failure = await observer.fetch('https://benchmark.example.test/responses');
  await failure.text();
  await expect(observer.fetch('https://benchmark.example.test/responses')).rejects.toThrow();
  expect(observer.readRequests()).toMatchObject([
    { status: 503, inputTokens: null, cachedInputTokens: null, outputTokens: null },
    { status: null, inputTokens: null, cachedInputTokens: null, outputTokens: null },
  ]);
  expect(JSON.stringify(observer.readRequests())).not.toContain('Private transport details');
});

it('keeps a cancelled response without terminal usage unmeasured', async () => {
  const fetchModel = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
          );
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );
  const observer = observeInteractiveModelFetch(fetchModel);
  const response = await observer.fetch('https://benchmark.example.test/responses');
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Missing response stream.');
  }
  await reader.read();
  await reader.cancel();
  expect(observer.readRequests()[0]).toMatchObject({
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
  });
});
