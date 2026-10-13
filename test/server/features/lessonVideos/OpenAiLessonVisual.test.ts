import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAiLessonVisual } from '../../../../src/server/features/lessonVideos/infrastructure/OpenAiLessonVisual.js';
import { OpenAiLessonContent } from '../../../../src/server/features/lessonVideos/infrastructure/OpenAiLessonContent.js';
import { LessonModelAttemptState } from '../../../../src/contracts/LessonVisuals.js';
import { LessonLayout } from '../../../../src/contracts/LessonVideos.js';
import { createLessonFixture } from './LessonVideoFixtures.js';
import type { LessonVisualRequest } from '../../../../src/server/features/lessonVideos/application/LessonVideoPorts.js';

const source =
  'export default function Scene() { return <svg viewBox="0 0 1176 390"><text x={40} y={80}>2</text></svg>; }';
const brief = {
  position: 0,
  objective: 'Show the available even digits.',
  description: 'Move 2, 4 and 6 into a group, revealing three choices.',
  priority: 1,
};
const screen = {
  layout: LessonLayout.EXAMPLE,
  title: 'Choose the units digit',
  points: ['The units digit is 2, 4 or 6.'],
  narration: 'Only three even digits can occupy the units place.',
};
const content = {
  title: 'Even numbers',
  screens: [screen, screen, screen],
};

function createRequest(): LessonVisualRequest {
  return {
    screen,
    brief,
    durationSeconds: 8,
    locale: 'en',
    settings: createLessonFixture().settings,
  };
}

function createResponse(value: unknown, status = 'completed') {
  return {
    id: 'resp_fixture',
    status,
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 1000, output_tokens: 300, input_tokens_details: { cached_tokens: 0 } },
  };
}

function mockResponse(body: unknown) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function readRequestBody(fetch: ReturnType<typeof mockResponse>, index: number): unknown {
  const body = fetch.mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected a JSON provider request.');
  }
  const value: unknown = JSON.parse(body);
  return value;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Offline')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('counts the exact visual instructions, schema and scene without class material or past history', async () => {
  const fetch = mockResponse({ input_tokens: 1300 });
  const provider = new OpenAiLessonVisual('fixture-key');
  const request = createRequest();
  expect(await provider.countRequest(request)).toBe(1300);
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify(createResponse({ source, edits: [] })), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  expect(await provider.generateVisual(request, AbortSignal.timeout(1000))).toMatchObject({
    kind: 'source',
    source,
    usage: { inputTokens: 1000, outputTokens: 300 },
  });

  const requestSchema = z.object({
    instructions: z.string(),
    input: z.string(),
    text: z.unknown(),
  });
  const count = requestSchema.parse(readRequestBody(fetch, 0));
  const generated = requestSchema.parse(readRequestBody(fetch, 1));
  expect(generated).toEqual(count);
  expect(generated.input).toContain(brief.objective);
  expect(generated.input).not.toContain('sources');
  expect(generated.input).not.toContain('history');
  expect(readRequestBody(fetch, 1)).toMatchObject({ max_output_tokens: 3000, store: false });
});

it('applies only unique focused edits and keeps the current source once in repair context', async () => {
  const fetch = mockResponse(
    createResponse({ source: null, edits: [{ search: '>2<', replace: '>4<' }] }),
  );
  const result = await new OpenAiLessonVisual('fixture-key').generateVisual(
    { ...createRequest(), source, diagnostic: 'The digit should be 4.' },
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({ kind: 'source', source: source.replace('>2<', '>4<') });
  const body = z.object({ input: z.string() }).parse(readRequestBody(fetch, 0));
  const input = z
    .object({ repair: z.object({ currentSource: z.string() }) })
    .parse(JSON.parse(body.input));
  expect(input.repair.currentSource).toBe(source);
});

it('rejects ambiguous edits instead of spending another request inside the adapter', async () => {
  const fetch = mockResponse(
    createResponse({ source: null, edits: [{ search: '2', replace: '4' }] }),
  );
  const result = await new OpenAiLessonVisual('fixture-key').generateVisual(
    { ...createRequest(), source: `${source}\n// 2` },
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({ kind: 'incomplete', usage: { outputTokens: 300 } });
  expect(result).not.toHaveProperty('source');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves an incomplete source and its receipt without labelling it executable', async () => {
  mockResponse(createResponse({ source, edits: [] }, 'incomplete'));
  expect(
    await new OpenAiLessonVisual('fixture-key').generateVisual(
      createRequest(),
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({
    kind: 'incomplete',
    source,
    usage: { inputTokens: 1000, outputTokens: 300 },
  });
});

it('does not retry a lost response and retains uncertain provider usage', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error('Private provider detail'));
  vi.stubGlobal('fetch', fetch);
  const result = await new OpenAiLessonVisual('fixture-key').generateVisual(
    createRequest(),
    AbortSignal.timeout(1000),
  );
  expect(result).toEqual({ kind: 'unavailable', usage: null, usageUncertain: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('Private');
});

it('propagates explicit cancellation rather than degrading the cancelled job', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await expect(
    new OpenAiLessonVisual('fixture-key').generateVisual(createRequest(), controller.signal),
  ).rejects.toThrow('Cancelled');
});

it('writes briefs in the existing content request and rejects duplicate scene references with usage retained', async () => {
  const fetch = mockResponse(createResponse({ content, briefs: [brief] }));
  const provider = new OpenAiLessonContent('fixture-key');
  const lesson = createLessonFixture();
  expect(await provider.generate(lesson, AbortSignal.timeout(1000))).toMatchObject({
    content,
    briefs: [brief],
  });
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify(createResponse({ content, briefs: [brief, brief] })), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(provider.generate(lesson, AbortSignal.timeout(1000))).rejects.toMatchObject({
    outcome: LessonModelAttemptState.INCOMPLETE,
    usage: { inputTokens: 1000, outputTokens: 300 },
    usageUncertain: false,
  });
});

it('keeps the baseline writer contract for saved jobs with optional visuals disabled', async () => {
  mockResponse(createResponse(content));
  const lesson = createLessonFixture();
  lesson.settings.visual.enabled = false;
  expect(
    await new OpenAiLessonContent('fixture-key').generate(lesson, AbortSignal.timeout(1000)),
  ).toMatchObject({ content, briefs: [] });
});

it('retains writer usage on output truncation and performs no hidden transport retry', async () => {
  const fetch = mockResponse(createResponse({}, 'incomplete'));
  const provider = new OpenAiLessonContent('fixture-key');
  await expect(
    provider.generate(createLessonFixture(), AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({
    outcome: LessonModelAttemptState.INCOMPLETE,
    usage: { inputTokens: 1000, outputTokens: 300 },
  });
  fetch.mockClear();
  fetch.mockRejectedValueOnce(new Error('Connection lost'));
  await expect(
    provider.generate(createLessonFixture(), AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({
    outcome: LessonModelAttemptState.UNAVAILABLE,
    usage: null,
    usageUncertain: true,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
