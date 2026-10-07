import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OpenAiMaterialPreparation } from '../../../../src/server/features/materials/infrastructure/OpenAiMaterialPreparation.js';
import { defaultMaterialGenerationPolicy } from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import type {
  MaterialProviderRequestEvent,
  MaterialGenerationContext,
  MaterialStageInput,
} from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import {
  MaterialPreparationReason,
  MaterialProviderOperation,
  MaterialProviderErrorKind,
} from '../../../../src/server/features/materials/application/MaterialPreparationError.js';

const input: MaterialStageInput = {
  kind: 'brief',
  materialId: randomUUID(),
  locale: 'en',
  passages: [],
  summaries: [],
  file: {
    id: randomUUID(),
    classId: randomUUID(),
    name: 'Lesson.pdf',
    bytes: Buffer.from('synthetic PDF'),
  },
};
const brief = {
  purpose: { text: 'Practice printing.', origin: 'suggestion', sourceIds: [] },
  topics: ['Python'],
  setup: [],
  practice: [],
  examples: [],
  uncertainties: [],
};

function mockResponse(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_material_test' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function completedResponse(value: unknown) {
  return {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('Unexpected unmocked test request')),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('uses the actual SDK parser for compact briefs', async () => {
  mockResponse(completedResponse(brief));
  const result = await new OpenAiMaterialPreparation('test-key').generate(
    input,
    AbortSignal.timeout(1000),
  );
  expect(result.output).toEqual({ kind: 'brief', brief });
});
it('counts the same schema and PDF inputs before generation, without generating a response', async () => {
  const fetch = mockResponse({ input_tokens: 123 });
  expect(
    await new OpenAiMaterialPreparation('test-key').countInput(input, AbortSignal.timeout(1000)),
  ).toBe(123);
  const url = fetch.mock.calls[0]?.[0];
  if (typeof url !== 'string') {
    throw new Error('Expected SDK URL.');
  }
  expect(url).toContain('/responses/input_tokens');
  const init = fetch.mock.calls[0]?.[1];
  expect(init?.body).toContain('data:application/pdf;base64,');
  expect(init?.body).toContain('document_brief');
  expect(init?.body).not.toContain('max_output_tokens');
});
it('refuses incomplete output and malformed briefs', async () => {
  mockResponse({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [],
    usage: {
      input_tokens: 8780,
      output_tokens: 2000,
      total_tokens: 10780,
      output_tokens_details: { reasoning_tokens: 1250 },
    },
  });
  await expect(
    new OpenAiMaterialPreparation('test-key').generate(input, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({
    diagnostic: {
      reason: MaterialPreparationReason.INCOMPLETE_RESPONSE,
      incompleteReason: 'max_output_tokens',
      usedInputTokens: 8780,
      usedOutputTokens: 2000,
      reasoningTokens: 1250,
      requestId: 'req_material_test',
    },
  });
  mockResponse(completedResponse({ ...brief, topics: ['x'.repeat(101)] }));
  await expect(
    new OpenAiMaterialPreparation('test-key').generate(input, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ diagnostic: { reason: MaterialPreparationReason.INVALID_DRAFT } });
});
it('retains only safe HTTP diagnostics', async () => {
  mockResponse({ error: { message: 'Private source test-key', type: 'rate_limit_error' } }, 429);
  const error: unknown = await new OpenAiMaterialPreparation('test-key')
    .generate(input, AbortSignal.timeout(1000))
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    diagnostic: {
      reason: MaterialPreparationReason.PROVIDER_REQUEST_FAILED,
      httpStatus: 429,
      requestId: 'req_material_test',
    },
  });
  expect(JSON.stringify(error)).not.toMatch(/Private|test-key/);
});

it('sends requested revisions and previous teacher wording through the SDK composition path', async () => {
  const composition = {
    summary: 'Revised printing lesson.',
    sections: [
      {
        title: 'Print',
        instruction: 'Run the file.',
        sourcePageIds: [randomUUID()],
        setup: [],
        practiceSuggestions: [],
      },
    ],
    questions: [],
  };
  const fetch = mockResponse(completedResponse(composition));
  const result = await new OpenAiMaterialPreparation('test-key').generate(
    {
      kind: 'composition',
      locale: 'en',
      teacherInstructions: 'Use IDLE.',
      documents: [],
      sourceUnits: [{ id: randomUUID(), materialId: randomUUID(), location: 'Page 1' }],
      sourceMap: [],
      sources: [],
      revision: {
        request: 'Add more practice.',
        previousSummary: 'Teacher wording.',
        previousSections: [{ title: 'Print', instruction: 'Run the file.' }],
        teacherNotes: [],
      },
    },
    AbortSignal.timeout(1000),
  );
  expect(result.output).toEqual({ kind: 'composition', composition });
  const body = fetch.mock.calls[0]?.[1]?.body;
  expect(body).toContain('adjust the previous summary and sections');
  expect(body).toContain('Preserve unaffected teacher wording');
  expect(body).toContain('Add more practice.');
  expect(body).toContain('Teacher wording.');
  expect(body).toContain('"max_output_tokens":60000');
});

it('correlates count and generation logs without logging source content or credentials', async () => {
  const report = vi.fn<(event: MaterialProviderRequestEvent) => void>();
  const context: MaterialGenerationContext = {
    classId: randomUUID(),
    jobId: randomUUID(),
    collectionVersion: 7,
    stageKey: 'a'.repeat(64),
  };
  const fetch = mockResponse({ input_tokens: 123 });
  const provider = new OpenAiMaterialPreparation(
    'test-key',
    defaultMaterialGenerationPolicy,
    report,
  );
  await provider.countInput(input, AbortSignal.timeout(1000), context);
  fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        ...completedResponse(brief),
        usage: { input_tokens: 123, output_tokens: 25 },
      }),
      {
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_material_test' },
      },
    ),
  );
  const result = await provider.generate(input, AbortSignal.timeout(1000), context);
  expect(result.output).toEqual({ kind: 'brief', brief });
  const events = report.mock.calls.map(([event]) => event);
  expect(events.map((event) => [event.operation, event.state])).toEqual([
    ['count_input', 'started'],
    ['count_input', 'completed'],
    ['generate', 'started'],
    ['generate', 'completed'],
  ]);
  for (const event of events) {
    expect(event).toMatchObject({
      ...context,
      generationStage: 'brief',
      materialId: input.materialId,
      model: 'gpt-5.4',
      timeoutMs: 90000,
      maxRetries: 0,
      signalAborted: false,
      passageCount: 0,
      documentCount: 0,
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(events[0]?.localRequestId).toBe(events[1]?.localRequestId);
  expect(events[2]?.localRequestId).toBe(events[3]?.localRequestId);
  expect(events[0]?.localRequestId).not.toBe(events[2]?.localRequestId);
  expect(events[1]?.inputTokens).toBe(123);
  expect(events[3]).toMatchObject({
    outputTokens: 25,
    requestId: 'req_material_test',
    maxOutputTokens: 2000,
  });
  expect(JSON.stringify(events)).not.toMatch(/test-key|Lesson.pdf|synthetic PDF|Practice printing/);
});

it.each([MaterialProviderOperation.COUNT_INPUT, MaterialProviderOperation.GENERATE])(
  'records nested connection causes during %s without replaying requests',
  async (operation) => {
    const cause = Object.assign(new Error('Private document at secret.host with test-key'), {
      code: 'ECONNRESET',
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError('Private request', { cause }));
    vi.stubGlobal('fetch', fetch);
    const report = vi.fn<(event: MaterialProviderRequestEvent) => void>();
    const provider = new OpenAiMaterialPreparation(
      'test-key',
      defaultMaterialGenerationPolicy,
      report,
    );
    const signal = AbortSignal.timeout(1000);
    const promise =
      operation === MaterialProviderOperation.COUNT_INPUT
        ? provider.countInput(input, signal)
        : provider.generate(input, signal);
    const error: unknown = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      diagnostic: {
        reason: MaterialPreparationReason.PROVIDER_REQUEST_FAILED,
        operation,
        generationStage: 'brief',
        providerErrorKind: MaterialProviderErrorKind.CONNECTION,
        networkCauseCode: 'ECONNRESET',
        signalAborted: false,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]?.[0]).toMatchObject({
      state: 'failed',
      operation,
      networkCauseCode: 'ECONNRESET',
    });
    expect(JSON.stringify([error, report.mock.calls])).not.toMatch(
      /Private|secret.host|test-key|synthetic PDF/,
    );
  },
);

it('distinguishes a provider timeout from a job deadline abort', async () => {
  const report = vi.fn<(event: MaterialProviderRequestEvent) => void>();
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new DOMException('Private timeout', 'AbortError')),
  );
  const provider = new OpenAiMaterialPreparation(
    'test-key',
    defaultMaterialGenerationPolicy,
    report,
  );
  await expect(provider.generate(input, new AbortController().signal)).rejects.toMatchObject({
    diagnostic: {
      reason: MaterialPreparationReason.PROVIDER_TIMEOUT,
      providerErrorKind: MaterialProviderErrorKind.TIMEOUT,
      signalAborted: false,
    },
  });
  report.mockClear();
  await expect(
    provider.generate(
      input,
      AbortSignal.abort(new DOMException('Private deadline', 'TimeoutError')),
    ),
  ).rejects.toMatchObject({
    diagnostic: {
      reason: MaterialPreparationReason.PROVIDER_REQUEST_FAILED,
      providerErrorKind: MaterialProviderErrorKind.ABORT,
      signalAborted: true,
      abortKind: 'timeout',
    },
  });
  expect(report.mock.calls[1]?.[0]).toMatchObject({ state: 'failed', abortKind: 'timeout' });
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/Private|test-key/);
});

it('omits unknown transport codes and unsafe request IDs from diagnostics', async () => {
  const report = vi.fn<(event: MaterialProviderRequestEvent) => void>();
  const cause = Object.assign(new Error('Private source'), { code: 'PRIVATE_DOCUMENT_DATA' });
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);
  vi.stubGlobal('fetch', fetch);
  const provider = new OpenAiMaterialPreparation(
    'test-key',
    defaultMaterialGenerationPolicy,
    report,
  );
  await provider.countInput(input, new AbortController().signal).catch(() => undefined);
  expect(report.mock.calls[1]?.[0]).not.toHaveProperty('networkCauseCode');
  report.mockClear();
  fetch.mockResolvedValue(
    new Response(JSON.stringify({ error: { message: 'Private source' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'x-request-id': 'PRIVATE/source?test-key' },
    }),
  );
  await provider.generate(input, new AbortController().signal).catch(() => undefined);
  expect(report.mock.calls[1]?.[0]).toMatchObject({
    state: 'failed',
    httpStatus: 429,
    providerErrorKind: 'http',
  });
  expect(report.mock.calls[1]?.[0]).not.toHaveProperty('requestId');
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/Private|PRIVATE|test-key/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not change generation success or failure if the diagnostic sink fails', async () => {
  const report = vi.fn<(event: MaterialProviderRequestEvent) => void>(() => {
    throw new Error('Logger unavailable');
  });
  const fetch = mockResponse(completedResponse(brief));
  const provider = new OpenAiMaterialPreparation(
    'test-key',
    defaultMaterialGenerationPolicy,
    report,
  );
  expect((await provider.generate(input, new AbortController().signal)).output).toEqual({
    kind: 'brief',
    brief,
  });
  fetch.mockClear();
  fetch.mockResolvedValue(
    new Response(JSON.stringify({ error: { message: 'Private source' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(provider.generate(input, new AbortController().signal)).rejects.toMatchObject({
    diagnostic: { httpStatus: 429 },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('sends configured composition headroom to the provider and records it in diagnostics', async () => {
  const fetch = mockResponse({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [],
  });
  const report = vi.fn<(event: MaterialProviderRequestEvent) => void>();
  const provider = new OpenAiMaterialPreparation(
    'test-key',
    { stageOutputTokens: 2000, compositionOutputTokens: 100000, compositionTimeoutMs: 300000 },
    report,
  );
  await provider
    .generate(
      {
        kind: 'composition',
        locale: 'en',
        teacherInstructions: '',
        documents: [],
        sourceUnits: [{ id: randomUUID(), materialId: randomUUID(), location: 'Page 1' }],
        sourceMap: [],
        sources: [],
      },
      new AbortController().signal,
    )
    .catch(() => undefined);
  expect(fetch.mock.calls[0]?.[1]?.body).toContain('"max_output_tokens":100000');
  expect(report.mock.calls[0]?.[0].maxOutputTokens).toBe(100000);
  expect(report.mock.calls[1]?.[0].maxOutputTokens).toBe(100000);
  expect(report.mock.calls[0]?.[0].timeoutMs).toBe(300000);
  expect(report.mock.calls[1]?.[0].timeoutMs).toBe(300000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('allows composition to keep running beyond the brief timeout and honors its own timeout', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error('Missing SDK request signal'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Synthetic timeout', 'AbortError'));
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const report = vi.fn<(event: MaterialProviderRequestEvent) => void>();
  const provider = new OpenAiMaterialPreparation(
    'test-key',
    defaultMaterialGenerationPolicy,
    report,
  );
  const result = provider
    .generate(
      {
        kind: 'composition',
        locale: 'en',
        teacherInstructions: '',
        documents: [],
        sourceUnits: [{ id: randomUUID(), materialId: randomUUID(), location: 'Page 1' }],
        sourceMap: [],
        sources: [],
      },
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(90001);
  expect(report.mock.calls.map(([event]) => event.state)).toEqual(['started']);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(150000);
  expect(await result).toMatchObject({
    diagnostic: { reason: MaterialPreparationReason.PROVIDER_TIMEOUT },
  });
  expect(report.mock.calls[1]?.[0]).toMatchObject({ state: 'failed', timeoutMs: 240000 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('counts and generates the identical constrained composition and repair packet', async () => {
  const pageId = randomUUID();
  const passageId = randomUUID();
  const materialId = randomUUID();
  const composition = {
    summary: 'Print',
    sections: [
      {
        title: 'Print',
        instruction: 'Print',
        sourcePageIds: [pageId],
        setup: [],
        practiceSuggestions: [],
      },
    ],
    questions: [],
  };
  const stage: Extract<MaterialStageInput, { kind: 'composition' }> = {
    kind: 'composition',
    locale: 'vi',
    teacherInstructions: '',
    documents: [],
    sources: [],
    sourceUnits: [{ id: pageId, materialId, location: 'Page 1' }],
    sourceMap: [{ passageId, pageId, materialId }],
    citationRepair: {
      previousComposition: composition,
      issues: [
        {
          path: 'composition.sections[0].sourcePageIds[0]',
          reason: 'wrong_reference_kind',
          expectedKind: 'page',
          actualKind: 'passage',
          sourceId: passageId,
          allowedReferenceCount: 1,
        },
      ],
      issueCount: 1,
      evidence: [],
    },
  };
  const fetch = mockResponse({ input_tokens: 100 });
  const events = vi.fn<(event: MaterialProviderRequestEvent) => void>();
  const provider = new OpenAiMaterialPreparation(
    'test-key',
    defaultMaterialGenerationPolicy,
    events,
  );
  await provider.countInput(stage, new AbortController().signal);
  fetch.mockResolvedValue(
    new Response(JSON.stringify(completedResponse(composition)), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await provider.generate(stage, new AbortController().signal);
  const bodies = fetch.mock.calls.map(([, options]) => {
    if (typeof options?.body !== 'string') {
      throw new Error('Missing request body.');
    }
    const body: unknown = JSON.parse(options.body);
    return z
      .object({
        model: z.string(),
        instructions: z.string(),
        input: z.unknown(),
        text: z.unknown(),
      })
      .parse(body);
  });
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]?.instructions).toContain('Vietnamese');
  expect(bodies[0]?.instructions).toContain('Correct only sourcePageIds/sourceIds arrays');
  expect(JSON.stringify(bodies[0]?.text)).toContain(pageId);
  expect(JSON.stringify(bodies[0]?.text)).toContain(passageId);
  expect(events.mock.calls.every(([event]) => event.citationRepair === true)).toBe(true);
  expect(JSON.stringify(events.mock.calls)).not.toMatch(/Print|wrong_reference_kind|test-key/);
});

it('rejects a composition with no page bindings before sending a provider request', async () => {
  const fetch = mockResponse({ input_tokens: 100 });
  const provider = new OpenAiMaterialPreparation('test-key');
  await expect(
    provider.countInput(
      {
        kind: 'composition',
        locale: 'en',
        teacherInstructions: '',
        documents: [],
        sources: [],
        sourceUnits: [],
        sourceMap: [],
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    diagnostic: { reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES },
  });
  expect(fetch).not.toHaveBeenCalled();
});
