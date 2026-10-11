import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MaterialPublicationSchema } from '#contracts/ClassroomMaterials.js';
import {
  GuidedLessonAction,
  GuidedLessonFailure,
  GuidedLessonReadAction,
  GuidedLessonReplySchema,
} from '#contracts/GuidedLessons.js';
import { GuidedLessonService } from '../../../../src/server/features/guidedLessons/application/GuidedLessonService.js';
import {
  LessonDataSource,
  parseLessonData,
  readLessonDataSource,
} from '../../../../src/server/features/guidedLessons/application/LessonDataValidation.js';
import {
  LessonError,
  LessonFailure,
} from '../../../../src/server/features/guidedLessons/application/LessonFailure.js';
import type {
  LessonModel,
  LessonRenderer,
  LessonSpeech,
} from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import { registerGuidedLessonRoutes } from '../../../../src/server/features/guidedLessons/infrastructure/RegisterGuidedLessonRoutes.js';
import {
  describeLessonRequestError,
  LessonRequestStage,
} from '../../../../src/server/features/guidedLessons/infrastructure/GuidedLessonRequestDiagnostics.js';
import { MemoryGuidedLessonStore } from './MemoryGuidedLessonStore.js';

const classId = '00000000-0000-4000-8000-000000000001';
const lessonId = '00000000-0000-4000-8000-000000000002';
const releaseId = '00000000-0000-4000-8000-000000000003';
const artifactId = '00000000-0000-4000-8000-000000000004';
const commandId = '00000000-0000-4000-8000-000000000005';
const privateText = 'private source text and provider credential';
const privateKey = 'private source heading';
const applications: FastifyInstance[] = [];

const LoggedValidationSchema = z.object({
  validation: z.strictObject({
    source: z.string(),
    issueCount: z.number().int().nonnegative(),
    issues: z.array(
      z.strictObject({
        code: z.string(),
        path: z.array(z.union([z.string(), z.number()])),
        pathTruncated: z.boolean(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        inclusive: z.boolean().optional(),
      }),
    ),
    issuesTruncated: z.boolean(),
  }),
});

function setup() {
  const api = Fastify();
  applications.push(api);
  const model = {
    countInput: vi
      .fn<LessonModel['countInput']>()
      .mockRejectedValue(new Error('Unexpected model count')),
    generate: vi
      .fn<LessonModel['generate']>()
      .mockRejectedValue(new Error('Unexpected model call')),
  } satisfies LessonModel;
  const speech = {
    synthesize: vi
      .fn<LessonSpeech['synthesize']>()
      .mockRejectedValue(new Error('Unexpected speech call')),
  } satisfies LessonSpeech;
  const renderer = {
    render: vi
      .fn<LessonRenderer['render']>()
      .mockRejectedValue(new Error('Unexpected rendering call')),
  } satisfies LessonRenderer;
  const store = new MemoryGuidedLessonStore();
  const service = new GuidedLessonService(store, model, speech, renderer);
  const warn = vi.fn<Logger['warn']>();
  registerGuidedLessonRoutes(api, () => Promise.resolve('teacher'), service, { warn });
  return { api, service, warn, store, model, speech, renderer };
}

function createStoredValidationError(): z.ZodError {
  const schema = z.strictObject({
    [privateKey]: z.string().min(3),
    passages: z.array(z.strictObject({ text: z.string().max(1) })),
  });
  try {
    parseLessonData(
      schema,
      {
        [privateKey]: 'x',
        passages: Array.from({ length: 10 }, () => ({ text: privateText })),
      },
      LessonDataSource.PUBLICATION,
    );
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the stored publication fixture to fail validation.');
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((api) => api.close()));
  vi.restoreAllMocks();
});

describe('guided lesson refusal diagnostics', () => {
  it('loads approved link material without a byte digest or provider work', async () => {
    const { api, warn, store, model, speech, renderer } = setup();
    const courseRevisionId = '00000000-0000-4000-8000-000000000006';
    const materialId = '00000000-0000-4000-8000-000000000007';
    const pageId = '00000000-0000-4000-8000-000000000008';
    const sectionId = '00000000-0000-4000-8000-000000000009';
    const url = 'https://example.test/lesson';
    const teacherNote = 'Use the uploaded lesson files for the worked example.';
    const publication = MaterialPublicationSchema.parse({
      classId,
      courseId: courseRevisionId,
      teacherInstructions: '',
      sources: [{ id: materialId, name: 'Lesson link', bytes: 0, digest: '', url }],
      draft: {
        summary: 'Approved lesson reference',
        sections: [
          {
            id: sectionId,
            title: 'Lesson reference',
            instruction: 'Read the published reference and teacher correction.',
            sourcePageIds: [pageId],
          },
        ],
        pages: [
          {
            id: pageId,
            materialId,
            location: 'Link',
            extractedText: url,
            preparedNote: '',
            teacherNote,
            warnings: ['Link content has not been fetched.'],
          },
        ],
        questions: [],
      },
    });
    const publishedSnapshot = structuredClone(publication);
    store.accesses.set(`teacher:${classId}`, {
      classId,
      teacherId: 'teacher',
      isTeacher: true,
      enrolled: false,
      courseRevisionId,
    });
    store.publications.set(courseRevisionId, publication);
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/guided-lessons/read',
      payload: { action: GuidedLessonReadAction.TEACHER_INPUT, classId },
    });
    expect(response.statusCode).toBe(200);
    const reply = GuidedLessonReplySchema.parse(response.json<unknown>());
    expect(reply.kind).toBe('teacherInput');
    if (reply.kind !== 'teacherInput') {
      throw new Error('Expected approved link material for the teacher.');
    }
    expect(reply.revisions[0]?.title).toBe('Lesson link');
    expect(reply.revisions[0]?.sections).toEqual([
      {
        id: sectionId,
        title: 'Lesson reference',
        passageIds: reply.passages.map((passage) => passage.passageId),
      },
    ]);
    const sourceDigest = createHash('sha256').update(url).digest('hex');
    expect(
      reply.passages.map((passage) => ({
        text: passage.text,
        sourceDigest: passage.sourceDigest,
        textDigest: passage.textDigest,
      })),
    ).toEqual([
      { text: url, sourceDigest, textDigest: sourceDigest },
      {
        text: teacherNote,
        sourceDigest,
        textDigest: createHash('sha256').update(teacherNote).digest('hex'),
      },
    ]);
    expect(store.publications.get(courseRevisionId)).toEqual(publishedSnapshot);
    expect(publication).toEqual(publishedSnapshot);
    for (const summary of ['Approved lesson reference', '']) {
      store.publications.set(courseRevisionId, {
        ...publication,
        sources: [],
        draft: { ...publication.draft, summary },
      });
      const nextResponse = await api.inject({
        method: 'POST',
        url: '/api/v1/guided-lessons/read',
        payload: { action: GuidedLessonReadAction.TEACHER_INPUT, classId },
      });
      expect(nextResponse.statusCode).toBe(200);
      const nextReply = GuidedLessonReplySchema.parse(nextResponse.json<unknown>());
      if (nextReply.kind !== 'teacherInput') {
        throw new Error('Expected approved material for the teacher.');
      }
      expect(nextReply.revisions[0]?.title).toBe(summary || courseRevisionId);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(model.countInput).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('preserves the original parser error and successful parsed values when tagging storage', () => {
    const parsed = z.string().max(1).safeParse(privateText);
    if (parsed.success) {
      throw new Error('Expected the private text fixture to fail validation.');
    }
    const originalError = parsed.error;
    const schema = z.unknown().transform(() => {
      throw originalError;
    });
    let thrown: unknown;
    try {
      parseLessonData(schema, privateText, LessonDataSource.PUBLICATION);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBe(originalError);
    expect(readLessonDataSource(originalError)).toBe(LessonDataSource.PUBLICATION);
    expect(
      parseLessonData(
        z.strictObject({ title: z.string().trim() }),
        { title: ' Approved material ' },
        LessonDataSource.PUBLICATION,
      ),
    ).toEqual({ title: 'Approved material' });
  });

  it('retains nested union field evidence while bounding and redacting deep paths', () => {
    const union = z
      .strictObject({
        draft: z.union([
          z.strictObject({ kind: z.literal('legacy'), sections: z.array(z.string()).max(1) }),
          z.strictObject({
            sections: z.union([z.array(z.string()).max(2), z.array(z.string()).max(3)]),
          }),
        ]),
      })
      .safeParse({ draft: { sections: Array.from({ length: 4 }, () => privateText) } });
    let deepSchema: z.ZodType = z.string().max(1);
    let deepInput: unknown = privateText;
    for (let depth = 0; depth < 16; depth += 1) {
      deepSchema = z.strictObject({ [privateKey]: deepSchema });
      deepInput = { [privateKey]: deepInput };
    }
    const deep = z.strictObject({ draft: deepSchema }).safeParse({ draft: deepInput });
    if (union.success || deep.success) {
      throw new Error('Expected the union and deep-path fixtures to fail validation.');
    }
    const diagnostics = describeLessonRequestError(
      new z.ZodError([...union.error.issues, ...deep.error.issues]),
      LessonRequestStage.SERVICE,
    );
    const { validation } = LoggedValidationSchema.parse(diagnostics);
    expect(validation.source).toBe('service');
    expect(validation.issueCount).toBe(2);
    for (const maximum of [1, 2, 3]) {
      expect(validation.issues).toContainEqual({
        code: 'too_big',
        path: ['draft', 'sections'],
        pathTruncated: false,
        maximum,
        inclusive: true,
      });
    }
    expect(validation.issues).toContainEqual({
      code: 'too_big',
      path: ['draft', ...Array.from({ length: 11 }, () => '[redacted]')],
      pathTruncated: true,
      maximum: 1,
      inclusive: true,
    });
    expect(validation.issues.length).toBeLessThanOrEqual(8);
    expect(validation.issues.every((issue) => issue.path.length <= 12)).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain(privateText);
    expect(JSON.stringify(diagnostics)).not.toContain(privateKey);
  });

  it('identifies request validation without logging unknown keys or values', async () => {
    const { api, service, warn } = setup();
    const read = vi.spyOn(service, 'read');
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/guided-lessons/read',
      payload: {
        action: GuidedLessonReadAction.TEACHER_INPUT,
        classId,
        lessonId: privateText,
        [privateKey]: privateText,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toEqual({
      kind: 'failed',
      code: GuidedLessonFailure.INVALID_REQUEST,
      message: 'The lesson request or source selection is invalid.',
    });
    expect(read).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    const logged: unknown = warn.mock.calls[0]?.[0];
    expect(logged).toMatchObject({
      stage: 'read',
      action: GuidedLessonReadAction.TEACHER_INPUT,
      failureStage: 'request',
      errorKind: 'validation',
      classId,
      validation: {
        source: 'request',
        issueCount: 1,
        issues: [{ code: 'unrecognized_keys', path: [], pathTruncated: false }],
        issuesTruncated: false,
      },
    });
    expect(logged).not.toHaveProperty('lessonId');
    expect(
      z.object({ elapsedMs: z.number().int().nonnegative() }).parse(logged).elapsedMs,
    ).toBeGreaterThanOrEqual(0);
    expect(warn.mock.calls[0]?.[1]).toBe('guided-lessons.request.refused');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateKey);
  });

  it('omits unvalidated action names and identifiers', async () => {
    const { api, warn } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/guided-lessons/read',
      payload: { action: privateText, classId: privateText, commandId: privateText },
    });
    expect(response.statusCode).toBe(400);
    const logged: unknown = warn.mock.calls[0]?.[0];
    expect(logged).toMatchObject({ action: null, failureStage: 'request' });
    expect(logged).not.toHaveProperty('classId');
    expect(logged).not.toHaveProperty('commandId');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
  });

  it('locates stored publication failures and bounds redacted schema evidence', async () => {
    const { api, service, warn } = setup();
    vi.spyOn(service, 'read').mockRejectedValue(createStoredValidationError());
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/guided-lessons/read',
      payload: { action: GuidedLessonReadAction.TEACHER_INPUT, classId },
    });
    expect(response.statusCode).toBe(400);
    const logged: unknown = warn.mock.calls[0]?.[0];
    expect(logged).toMatchObject({
      stage: 'read',
      action: GuidedLessonReadAction.TEACHER_INPUT,
      failureStage: 'service',
      errorKind: 'validation',
    });
    const { validation } = LoggedValidationSchema.parse(logged);
    expect(validation.source).toBe('publication');
    expect(validation.issueCount).toBe(11);
    expect(validation.issues).toHaveLength(8);
    expect(validation.issuesTruncated).toBe(true);
    expect(validation.issues[0]).toEqual({
      code: 'too_small',
      path: ['[redacted]'],
      pathTruncated: false,
      minimum: 3,
      inclusive: true,
    });
    expect(validation.issues[1]).toEqual({
      code: 'too_big',
      path: ['passages', 0, 'text'],
      pathTruncated: false,
      maximum: 1,
      inclusive: true,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateKey);
  });

  it('distinguishes response validation from malformed requests', async () => {
    const { api, service, warn } = setup();
    vi.spyOn(service, 'read').mockResolvedValue({
      kind: 'teacherInput',
      classId,
      revisions: [{ id: lessonId, title: privateText.repeat(20), sections: [] }],
      passages: [],
    });
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/guided-lessons/read',
      payload: { action: GuidedLessonReadAction.TEACHER_INPUT, classId },
    });
    expect(response.statusCode).toBe(400);
    const logged: unknown = warn.mock.calls[0]?.[0];
    expect(logged).toMatchObject({
      stage: 'read',
      action: GuidedLessonReadAction.TEACHER_INPUT,
      failureStage: 'response',
      errorKind: 'validation',
    });
    expect(LoggedValidationSchema.parse(logged).validation).toEqual({
      source: 'response',
      issueCount: 1,
      issues: [
        {
          code: 'too_big',
          path: ['revisions', 0, 'title'],
          pathTruncated: false,
          maximum: 300,
          inclusive: true,
        },
      ],
      issuesTruncated: false,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
  });

  it.each([
    [LessonFailure.INVALID, 400, GuidedLessonFailure.INVALID_REQUEST],
    [LessonFailure.FORBIDDEN, 403, GuidedLessonFailure.UNAUTHORIZED],
    [LessonFailure.STALE, 409, GuidedLessonFailure.CONFLICT],
    [LessonFailure.BUDGET, 409, GuidedLessonFailure.BUDGET_EXCEEDED],
    [LessonFailure.UNCERTAIN, 409, GuidedLessonFailure.BUDGET_EXCEEDED],
    [LessonFailure.UNAVAILABLE, 503, GuidedLessonFailure.UNAVAILABLE],
  ] as const)(
    'preserves the %s refusal status and identifies the command',
    async (code, status, replyCode) => {
      const { api, service, warn } = setup();
      vi.spyOn(service, 'execute').mockRejectedValue(new LessonError(code));
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/guided-lessons/command',
        payload: {
          action: GuidedLessonAction.START,
          classId,
          lessonId,
          commandId,
          expectedVersion: 0,
        },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json<unknown>()).toMatchObject({ kind: 'failed', code: replyCode });
      const logged: unknown = warn.mock.calls[0]?.[0];
      expect(logged).toMatchObject({
        stage: 'command',
        action: GuidedLessonAction.START,
        failureStage: 'service',
        errorKind: 'lesson',
        code: replyCode,
        classId,
        lessonId,
        commandId,
      });
      expect(logged).not.toHaveProperty('validation');
    },
  );

  it('keeps unexpected service errors private without changing availability refusals', async () => {
    const { api, service, warn } = setup();
    vi.spyOn(service, 'read').mockRejectedValue(new Error(privateText));
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/guided-lessons/read',
      payload: { action: GuidedLessonReadAction.REQUESTS, classId },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toEqual({
      kind: 'failed',
      code: GuidedLessonFailure.UNAVAILABLE,
      message: 'Guided lessons are temporarily unavailable.',
    });
    const logged: unknown = warn.mock.calls[0]?.[0];
    expect(logged).toMatchObject({
      stage: 'read',
      action: GuidedLessonReadAction.REQUESTS,
      failureStage: 'service',
      errorKind: 'unexpected',
    });
    expect(logged).not.toHaveProperty('validation');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
    expect(response.body).not.toContain(privateText);
  });

  it('distinguishes artifact query validation from artifact service failures', async () => {
    const { api, service, warn } = setup();
    const readArtifact = vi
      .spyOn(service, 'readArtifact')
      .mockRejectedValue(new LessonError(LessonFailure.FORBIDDEN));
    const url = `/api/v1/guided-lessons/${classId}/${lessonId}/artifacts/${artifactId}`;
    const malformed = await api.inject({
      method: 'GET',
      url: `${url}?releaseId=${encodeURIComponent(privateText)}`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(readArtifact).not.toHaveBeenCalled();
    const malformedLog: unknown = warn.mock.calls[0]?.[0];
    expect(malformedLog).toMatchObject({
      stage: 'artifact',
      action: null,
      failureStage: 'request',
      errorKind: 'validation',
      classId,
      lessonId,
      artifactId,
      validation: { source: 'request' },
    });
    expect(malformedLog).not.toHaveProperty('releaseId');
    const refused = await api.inject({ method: 'GET', url: `${url}?releaseId=${releaseId}` });
    expect(refused.statusCode).toBe(403);
    const refusedLog: unknown = warn.mock.calls[1]?.[0];
    expect(refusedLog).toMatchObject({
      stage: 'artifact',
      action: null,
      failureStage: 'service',
      errorKind: 'lesson',
      classId,
      lessonId,
      artifactId,
      releaseId,
    });
    expect(warn.mock.calls[0]?.[1]).toBe('guided-lessons.artifact.refused');
    expect(warn.mock.calls[1]?.[1]).toBe('guided-lessons.artifact.refused');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
  });

  it('does not emit refusal warnings for successful reads', async () => {
    const { api, warn } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/guided-lessons/read',
      payload: { action: GuidedLessonReadAction.LIST },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({ kind: 'list', classes: [], lessons: [] });
    expect(warn).not.toHaveBeenCalled();
  });
});
