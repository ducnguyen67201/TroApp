import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OpenAiMaterialPreparation } from '../../../../src/server/features/materials/infrastructure/OpenAiMaterialPreparation.js';
import type { MaterialStageInput } from '../../../../src/server/features/materials/application/MaterialGeneration.js';
import { MaterialPreparationReason } from '../../../../src/server/features/materials/application/MaterialPreparationError.js';

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

afterEach(() => vi.unstubAllGlobals());
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
  });
  await expect(
    new OpenAiMaterialPreparation('test-key').generate(input, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({
    diagnostic: {
      reason: MaterialPreparationReason.INCOMPLETE_RESPONSE,
      incompleteReason: 'max_output_tokens',
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
      sourceUnits: [],
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
});
