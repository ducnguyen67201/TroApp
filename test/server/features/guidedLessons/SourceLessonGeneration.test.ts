import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  LessonStatus,
  ReviewCheckStatus,
  ReviewCriterion,
  ReviewVerdict,
  type ReviewResult,
} from '#contracts/GuidedLessons.js';
import { GuidedLessonService } from '../../../../src/server/features/guidedLessons/application/GuidedLessonService.js';
import {
  LessonModelStage,
  type LessonModel,
  type LessonRenderer,
  type LessonSpeech,
} from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import type { LessonRecord } from '../../../../src/server/features/guidedLessons/application/LessonState.js';
import { hashLessonValue } from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import { createLessonFixture } from './LessonFixture.js';
import { createSourceLessonFixture } from './SourceLessonFixture.js';
import { createStoredLesson } from './StoredLessonFixture.js';
import { MemoryGuidedLessonStore } from './MemoryGuidedLessonStore.js';

function setup(criteria: ReviewCriterion[], code = false, visual = false) {
  const fixture = code ? createLessonFixture() : createSourceLessonFixture();
  const now = () => new Date('2026-10-10T12:00:00.000Z');
  const store = new MemoryGuidedLessonStore();
  const record: LessonRecord = {
    ...createStoredLesson(),
    ...fixture.record,
    status: visual ? LessonStatus.REVIEWING_VISUALS : LessonStatus.ADMITTED,
    plan: visual ? fixture.plan : null,
    contentHash: visual ? fixture.record.contentHash : null,
    manifest: visual ? fixture.record.manifest : null,
    speech: [],
    scriptApproved: false,
    previewApproved: false,
    scriptApproval: null,
    previewApproval: null,
    releaseId: null,
    run: {
      id: 'source-run',
      day: '2026-10-10',
      stage: LessonStatus.ADMITTED,
      claimId: null,
      leaseUntil: null,
      dispatched: false,
      contentRepairs: 0,
      visualRepairs: 0,
      physicalAttempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      speechAttempts: 0,
      speechCharacters: 0,
      renderRetries: 0,
    },
  };
  store.lessons.set(record.id, record);
  store.accesses.set(`teacher:${record.classId}`, {
    classId: record.classId,
    teacherId: 'teacher',
    isTeacher: true,
    enrolled: false,
    courseRevisionId: record.input.courseRevisionId,
  });
  const generate = vi.fn<LessonModel['generate']>().mockImplementation((request) => {
    if (request.stage === LessonModelStage.DRAFT) {
      return Promise.resolve({
        result: { status: 'ready', plan: fixture.plan },
        usage: { inputTokens: 100, outputTokens: 100 },
      });
    }
    const review: ReviewResult = {
      reviewedHash:
        request.stage === LessonModelStage.VISUAL_REVIEW
          ? hashLessonValue(request.manifest)
          : request.contentHash,
      verdict: ReviewVerdict.PASS,
      checks: criteria.map((criterion) => ({
        criterion,
        status: ReviewCheckStatus.PASS,
        evidenceIds: [],
      })),
      issues: [],
      unassessed: [],
    };
    return Promise.resolve({ result: review, usage: { inputTokens: 100, outputTokens: 100 } });
  });
  const model: LessonModel = {
    countInput: vi.fn<LessonModel['countInput']>().mockResolvedValue(100),
    generate,
  };
  const synthesize = vi
    .fn<LessonSpeech['synthesize']>()
    .mockRejectedValue(new Error('Unexpected speech call'));
  const render = vi
    .fn<LessonRenderer['render']>()
    .mockRejectedValue(new Error('Unexpected render call'));
  const speech: LessonSpeech = { synthesize };
  const renderer: LessonRenderer = { render };
  const service = new GuidedLessonService(store, model, speech, renderer, now);

  function readRecord(): LessonRecord {
    const current = store.lessons.get(record.id);
    if (!current) {
      throw new Error('Stored source fixture absent.');
    }
    return current;
  }

  return { service, generate, synthesize, render, fixture, readRecord };
}

it('drafts and reviews a source-only lesson while retaining explicit script approval before rendering', async () => {
  const fixture = setup([ReviewCriterion.SOURCE_SUPPORT]);
  await fixture.service.prepareNextLesson();
  expect(fixture.readRecord().status).toBe(LessonStatus.REVIEWING_CONTENT);
  expect(fixture.readRecord().plan?.checkpoints).toEqual([]);
  await fixture.service.prepareNextLesson();
  const reviewed = fixture.readRecord();
  expect(reviewed.status).toBe(LessonStatus.AWAITING_SCRIPT_APPROVAL);
  expect(reviewed.scriptApproved).toBe(false);
  await expect(
    fixture.service.execute('teacher', {
      action: 'render',
      commandId: randomUUID(),
      classId: reviewed.classId,
      lessonId: reviewed.id,
      expectedVersion: reviewed.version,
    }),
  ).rejects.toMatchObject({ code: 'invalidPlan' });
  const contentHash = reviewed.contentHash;
  if (!contentHash) {
    throw new Error('Reviewed source lesson has no content hash.');
  }
  const approval = {
    action: 'approveScript',
    commandId: randomUUID(),
    classId: reviewed.classId,
    lessonId: reviewed.id,
    expectedVersion: reviewed.version,
    contentHash,
    acknowledgedSceneIds: fixture.fixture.plan.scenes.map((scene) => scene.sceneId),
  } as const;
  await expect(
    fixture.service.execute('teacher', {
      ...approval,
      commandId: randomUUID(),
      acknowledgedSceneIds: approval.acknowledgedSceneIds.slice(0, 1),
    }),
  ).rejects.toMatchObject({ code: 'invalidPlan' });
  await fixture.service.execute('teacher', approval);
  expect(fixture.readRecord().scriptApproval?.contentHash).toBe(contentHash);
  expect(fixture.readRecord().scriptApproved).toBe(true);
  expect(fixture.synthesize).not.toHaveBeenCalled();
  expect(fixture.render).not.toHaveBeenCalled();
});

it('rejects a passing source-only review without source support', async () => {
  const fixture = setup([ReviewCriterion.TRACE_CORRECTNESS]);
  await fixture.service.prepareNextLesson();
  await fixture.service.prepareNextLesson();
  expect(fixture.readRecord().status).toBe(LessonStatus.FAILED);
  expect(fixture.readRecord().scriptApproved).toBe(false);
});

it.each([ReviewCriterion.TRACE_CORRECTNESS, ReviewCriterion.CHECKPOINT])(
  'keeps %s mandatory for a code lesson review',
  async (omitted) => {
    const fixture = setup(
      [
        ReviewCriterion.SOURCE_SUPPORT,
        ReviewCriterion.TRACE_CORRECTNESS,
        ReviewCriterion.CHECKPOINT,
      ].filter((criterion) => criterion !== omitted),
      true,
    );
    await fixture.service.prepareNextLesson();
    await fixture.service.prepareNextLesson();
    expect(fixture.readRecord().status).toBe(LessonStatus.FAILED);
  },
);

const visualCriteria = [
  ReviewCriterion.READABILITY,
  ReviewCriterion.HIERARCHY,
  ReviewCriterion.CONTINUITY,
  ReviewCriterion.TIMELINE,
  ReviewCriterion.ASSETS,
];

it('accepts applicable visual checks without an invented source-only checkpoint review', async () => {
  const fixture = setup(visualCriteria, false, true);
  await fixture.service.prepareNextLesson();
  expect(fixture.readRecord().status).toBe(LessonStatus.PREVIEW_READY);
  expect(fixture.readRecord().previewApproved).toBe(false);
});

it('still rejects missing essential visual checks for a source-only lesson', async () => {
  const fixture = setup(
    visualCriteria.filter((criterion) => criterion !== ReviewCriterion.READABILITY),
    false,
    true,
  );
  await fixture.service.prepareNextLesson();
  expect(fixture.readRecord().status).toBe(LessonStatus.FAILED);
});

it('keeps visual checkpoint review mandatory when a checkpoint is present', async () => {
  const fixture = setup(visualCriteria, true, true);
  await fixture.service.prepareNextLesson();
  expect(fixture.readRecord().status).toBe(LessonStatus.FAILED);
});
