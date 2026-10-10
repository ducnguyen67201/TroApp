import { expect, it } from 'vitest';
import { LessonPlanSchema, TraceOperation } from '#contracts/GuidedLessons.js';
import {
  readCheckpointAnswer,
  validateLessonInput,
  validateLessonPlan,
} from '../../../../src/server/features/guidedLessons/domain/ValidateLessonPlan.js';
import { createLessonFixture } from './LessonFixture.js';

it('accepts a grounded canonical lesson and grades from the trace', () => {
  const { input, plan } = createLessonFixture();
  expect(validateLessonPlan(input, plan)).toEqual([]);
  const checkpoint = plan.checkpoints[0];
  if (!checkpoint) {
    throw new Error('Fixture checkpoint absent.');
  }
  expect(readCheckpointAnswer(input, checkpoint)).toBe(2);
});

it('blocks stale source identity and fabricated event IDs', () => {
  const { input, plan } = createLessonFixture();
  const scene = plan.scenes[0];
  if (!scene || scene.kind !== 'codeTrace') {
    throw new Error('Fixture scene absent.');
  }
  scene.params.traceEventIds = ['fabricated-event'];
  plan.courseRevisionId = 'different-course';
  const issues = validateLessonPlan(input, plan);
  expect(issues.some((issue) => issue.criterion === 'sourceSupport')).toBe(true);
  expect(issues.some((issue) => issue.criterion === 'traceCorrectness')).toBe(true);
});

it('requires an exact narration cue for a displayed intermediate binding event', () => {
  const { input, plan } = createLessonFixture();
  const scene = plan.scenes.find((candidate) => candidate.sceneId === 'continue');
  const bindingEvent = input.traces[0]?.events.find(
    (event) =>
      event.operation === TraceOperation.BIND_ITEM &&
      scene?.narration.some((beat) => beat.traceEventId === event.eventId),
  );
  if (!scene || scene.kind !== 'codeTrace' || !bindingEvent) {
    throw new Error('Fixture continuation binding absent.');
  }
  scene.narration = scene.narration.filter((beat) => beat.traceEventId !== bindingEvent.eventId);
  expect(validateLessonPlan(input, plan)).toMatchObject([
    {
      criterion: 'timeline',
      sceneId: scene.sceneId,
      observed: 'A visible trace event has no approved narration cue.',
    },
  ]);

  scene.params.traceEventIds = scene.params.traceEventIds.filter(
    (eventId) => eventId !== bindingEvent.eventId,
  );
  expect(validateLessonPlan(input, plan)).toEqual([]);
});

it('rejects out-of-range approval citations before model admission', () => {
  const { input } = createLessonFixture();
  const block = input.codeBlocks[0];
  if (!block) {
    throw new Error('Fixture code absent.');
  }
  block.sourceRefs = [{ passageId: 'passage-1', startOffset: 0, endOffset: 9999 }];
  expect(validateLessonInput(input).some((issue) => issue.criterion === 'sourceSupport')).toBe(
    true,
  );
});

it('keeps published corrections separate and requires their citation', () => {
  const { input, plan } = createLessonFixture();
  const source = input.passages[0];
  if (!source) {
    throw new Error('Fixture source absent.');
  }
  input.passages.push({
    ...source,
    passageId: 'correction-1',
    ownerSourceId: 'teacher-note',
    kind: 'pageCorrection',
    correctsPassageIds: [source.passageId],
    text: 'The input can also be negative.',
  });
  expect(
    validateLessonPlan(input, plan).some((issue) =>
      issue.observed.includes('published teacher correction'),
    ),
  ).toBe(true);
});

it('does not accept a model-invented choice answer key', () => {
  const { input, plan } = createLessonFixture();
  const checkpoint = plan.checkpoints[0];
  const scene = plan.scenes.find((candidate) => candidate.sceneId === checkpoint?.sceneId);
  if (!checkpoint || !scene || scene.kind !== 'checkpoint') {
    throw new Error('Fixture checkpoint absent.');
  }
  checkpoint.kind = 'sourceChoice';
  checkpoint.options = [
    { optionId: 'a', text: 'A' },
    { optionId: 'b', text: 'B' },
  ];
  checkpoint.answerRef = { kind: 'teacherAnswer', answerKeyId: 'invented' };
  scene.params.traceId = null;
  scene.params.holdEventId = null;
  expect(validateLessonPlan(input, plan).some((issue) => issue.criterion === 'checkpoint')).toBe(
    true,
  );
  expect(() => readCheckpointAnswer(input, checkpoint)).toThrow('no authoritative answer');
});

it('accepts only the exact teacher-approved choice question and options', () => {
  const { input, plan } = createLessonFixture();
  const checkpoint = plan.checkpoints[0];
  const scene = plan.scenes.find((candidate) => candidate.sceneId === checkpoint?.sceneId);
  if (!checkpoint || !scene || scene.kind !== 'checkpoint') {
    throw new Error('Fixture checkpoint absent.');
  }
  input.teacherAnswerKeys.push({
    answerKeyId: 'key-1',
    question: 'What persists between iterations?',
    options: [
      { optionId: 'a', text: 'The running total' },
      { optionId: 'b', text: 'Only the printed output' },
    ],
    correctOptionId: 'a',
    sourceRefs: checkpoint.sourceRefs,
    approvalReceiptId: 'approved-key',
  });
  checkpoint.kind = 'sourceChoice';
  checkpoint.question = 'What persists between iterations?';
  checkpoint.options = [
    { optionId: 'a', text: 'The running total' },
    { optionId: 'b', text: 'Only the printed output' },
  ];
  checkpoint.answerRef = { kind: 'teacherAnswer', answerKeyId: 'key-1' };
  scene.params.traceId = null;
  scene.params.holdEventId = null;
  expect(readCheckpointAnswer(input, checkpoint)).toBe('a');
  checkpoint.question = 'What does not persist between iterations?';
  expect(
    validateLessonPlan(input, plan).some((issue) => issue.observed.includes('exact approved')),
  ).toBe(true);
});

it('rejects answer exposure in earlier scenes and requires approved practice variants', () => {
  const { input, plan, held } = createLessonFixture();
  const scene = plan.scenes[0];
  const checkpoint = plan.checkpoints[0];
  if (!scene || scene.kind !== 'codeTrace' || !checkpoint) {
    throw new Error('Fixture scene absent.');
  }
  scene.params.traceEventIds.push(held.eventId);
  checkpoint.phase = 'try';
  const issues = validateLessonPlan(input, plan);
  expect(issues.some((issue) => issue.observed.includes('earlier scene reveals'))).toBe(true);
  expect(issues.some((issue) => issue.observed.includes('phase does not match'))).toBe(true);
});

it('rejects an unqualified template and bounds total speech across worked explanations', () => {
  const { input, plan } = createLessonFixture();
  const scene = plan.scenes[0];
  if (!scene) {
    throw new Error('Fixture scene absent.');
  }
  scene.layoutVariant = 'model-invented';
  const longPlan = LessonPlanSchema.parse({
    ...plan,
    scenes: plan.scenes.map((candidate) => ({
      ...candidate,
      narration: candidate.narration.map((beat) => ({ ...beat, text: 'x'.repeat(1000) })),
    })),
  });
  const issues = validateLessonPlan(input, longPlan);
  expect(issues.some((issue) => issue.criterion === 'style')).toBe(true);
  expect(issues.some((issue) => issue.criterion === 'timeline')).toBe(true);
});
