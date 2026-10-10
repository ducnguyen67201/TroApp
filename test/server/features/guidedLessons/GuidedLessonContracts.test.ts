import { expect, it } from 'vitest';
import {
  GuidedLessonArtifactReplySchema,
  GuidedLessonCommandSchema,
  GuidedLessonReadRequestSchema,
  LearnerProjectionSchema,
  LessonInputSchema,
} from '#contracts/GuidedLessons.js';
import { buildLessonProjection } from '../../../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';
import { createLessonFixture } from './LessonFixture.js';

it('rejects arbitrary action fields and requires explicit approved code inputs', () => {
  const command = {
    action: 'create',
    commandId: '67ef4bc4-7f79-41e6-952e-62e6584d2b48',
    classId: 'class-1',
    courseRevisionId: 'course-1',
    conceptId: 'loop',
    objective: 'Explain the loop.',
    audience: 'Beginners',
    language: 'en',
    targetDurationSeconds: 60,
    passageIds: ['passage-1'],
    teacherInstructions: '',
    codeApproval: null,
    practiceCodeApproval: null,
  };
  expect(GuidedLessonCommandSchema.safeParse(command).success).toBe(true);
  expect(GuidedLessonCommandSchema.safeParse({ ...command, runCode: 'import os' }).success).toBe(
    false,
  );
  expect(
    GuidedLessonCommandSchema.safeParse({ ...command, practiceCodeApproval: undefined }).success,
  ).toBe(false);
  expect(
    GuidedLessonCommandSchema.safeParse({ ...command, audience: 'x'.repeat(401) }).success,
  ).toBe(false);
  expect(
    GuidedLessonReadRequestSchema.safeParse({
      action: 'preview',
      classId: 'class-1',
      lessonId: 'lesson-1',
    }).success,
  ).toBe(true);
});

it('rejects untrusted source metadata and raw trace events in learner projections', () => {
  const fixture = createLessonFixture();
  expect(LessonInputSchema.safeParse({ ...fixture.input, shell: 'python' }).success).toBe(false);
  const projection = buildLessonProjection({ ...fixture, sceneId: 'predict' });
  expect(LearnerProjectionSchema.safeParse(projection).success).toBe(true);
  expect(
    LearnerProjectionSchema.safeParse({ ...projection, visibleTraceStates: [fixture.held] })
      .success,
  ).toBe(false);
  expect(
    LearnerProjectionSchema.safeParse({ ...projection, checkpoints: fixture.plan.checkpoints })
      .success,
  ).toBe(false);
});

it('transports bounded binary artifacts without accepting base64 or paths', () => {
  const artifact = {
    kind: 'artifact',
    artifactId: 'audio-1',
    mimeType: 'audio/wav',
    bytes: new Uint8Array([1, 2]),
    digest: 'a'.repeat(64),
  };
  expect(GuidedLessonArtifactReplySchema.safeParse(artifact).success).toBe(true);
  expect(GuidedLessonArtifactReplySchema.safeParse({ ...artifact, bytes: 'AQI=' }).success).toBe(
    false,
  );
  expect(
    GuidedLessonArtifactReplySchema.safeParse({ ...artifact, path: '/private/audio.wav' }).success,
  ).toBe(false);
  expect(
    GuidedLessonArtifactReplySchema.safeParse({
      ...artifact,
      bytes: new Uint8Array(16 * 1024 * 1024 + 1),
    }).success,
  ).toBe(false);
});
