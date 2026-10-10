import { describe, expect, it, vi } from 'vitest';
import { OpenAiLessonModel } from '../../../../src/server/features/guidedLessons/infrastructure/OpenAiLessonModel.js';
import {
  LessonModelStage,
  type LessonModelRequest,
} from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import { createLessonFixture } from './LessonFixture.js';
import { buildLessonProjection } from '../../../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';

function readBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected serialized JSON request.');
  }
  return init.body;
}

function readRequest(): LessonModelRequest {
  const fixture = createLessonFixture();
  return {
    stage: LessonModelStage.DRAFT,
    input: fixture.input,
    plan: null,
    review: null,
    manifest: null,
    evidence: [],
    contentHash: fixture.record.contentHash ?? '',
    maxOutputTokens: 6000,
  };
}

describe('structured lesson model adapter', () => {
  it('counts and dispatches identical instructions/input/schema with no automatic retries', async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>((url, init) => {
      const raw: unknown = JSON.parse(readBody(init));
      bodies.push(raw);
      if ((url instanceof Request ? url.url : url.toString()).endsWith('/input_tokens')) {
        return Promise.resolve(Response.json({ input_tokens: 123 }));
      }
      return Promise.resolve(
        Response.json({
          id: 'resp_test',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    result: {
                      status: 'needsTeacherInput',
                      questions: ['Confirm the example.'],
                      unsupportedRequirements: [],
                    },
                  }),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
        }),
      );
    });
    const model = new OpenAiLessonModel('synthetic-test-key', 'gpt-5.4', fetcher);
    const request = readRequest();
    expect(await model.countInput(request)).toBe(123);
    const generated = await model.generate(request, new AbortController().signal);
    expect(generated.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
    expect(generated.result).toMatchObject({ status: 'needsTeacherInput' });
    expect(bodies[1]).toMatchObject(bodies[0] ?? {});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns usage when output is malformed instead of making a format repair', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          id: 'resp_test',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{bad', annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }),
      ),
    );
    const generated = await new OpenAiLessonModel(
      'synthetic-test-key',
      'gpt-5.4',
      fetcher,
    ).generate(readRequest(), new AbortController().signal);
    expect(generated).toEqual({ result: null, usage: { inputTokens: 10, outputTokens: 20 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends only the safe visible context to lesson help', async () => {
    const fixture = createLessonFixture();
    const projection = buildLessonProjection({ ...fixture, hashValue: fixture.hashValue });
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      const text = readBody(init);
      expect(text).not.toContain('teacherAnswerKeys');
      expect(text).not.toContain('workedExplanation');
      expect(text).not.toContain('"traces":');
      expect(text).toContain('visibleProjection');
      return Promise.resolve(Response.json({ input_tokens: 100 }));
    });
    await new OpenAiLessonModel('synthetic-test-key', 'gpt-5.4', fetcher).countInput({
      ...readRequest(),
      stage: LessonModelStage.HELP,
      helpContext: {
        question: 'Explain this step.',
        visibleProjection: projection,
        sourcePassages: fixture.input.passages,
        history: [],
      },
    });
  });
});
