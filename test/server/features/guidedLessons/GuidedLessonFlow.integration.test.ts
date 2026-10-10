import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { MaterialPublicationSchema } from '#contracts/ClassroomMaterials.js';
import {
  CheckpointKind,
  CheckpointPhase,
  LessonLanguage,
  LessonPhase,
  LessonPlanSchema,
  LessonStatus,
  LessonTemplateKind,
  ReviewCheckStatus,
  ReviewCriterion,
  ReviewVerdict,
  TraceOperation,
  TraceStateView,
  type GuidedLessonDetail,
  type GuidedLessonReply,
  type LessonInput,
  type LessonPlan,
  type NarrationBeat,
} from '#contracts/GuidedLessons.js';
import {
  buildPublicationLessonPassages,
  hashLessonText,
  hashLessonValue,
} from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import { GuidedLessonService } from '../../../../src/server/features/guidedLessons/application/GuidedLessonService.js';
import {
  LessonModelStage,
  type LessonModel,
  type LessonSpeech,
} from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import { RemotionLessonRenderer } from '../../../../src/server/features/guidedLessons/infrastructure/RemotionLessonRenderer.js';
import { validateLessonPlan } from '../../../../src/server/features/guidedLessons/domain/ValidateLessonPlan.js';
import { MemoryGuidedLessonStore } from './MemoryGuidedLessonStore.js';

function createApprovedPublication() {
  const materialId = randomUUID();
  const pageId = randomUUID();
  const code =
    'numbers = [2, 4, 6]\ntotal = 0\nfor number in numbers:\n    total = total + number\nprint(total)';
  return {
    code,
    publication: MaterialPublicationSchema.parse({
      classId: randomUUID(),
      courseId: randomUUID(),
      teacherInstructions: '',
      sources: [
        {
          id: materialId,
          name: 'Approved loop lecture',
          bytes: code.length,
          digest: hashLessonText(code),
          url: null,
        },
      ],
      draft: {
        summary: 'Trace a running total.',
        questions: [],
        sections: [
          {
            id: randomUUID(),
            title: 'Accumulator',
            instruction: 'Explain each update.',
            sourcePageIds: [pageId],
          },
        ],
        pages: [
          {
            id: pageId,
            materialId,
            location: 'Page 1',
            extractedText: code,
            preparedNote: 'This generated note is not source evidence.',
            teacherNote: 'Keep total outside the loop.',
            warnings: [],
          },
        ],
      },
    }),
  };
}

/** A local test author binds the generated plan to the actual server-compiled approval receipt. */
function createSyntheticPlan(input: LessonInput): LessonPlan {
  const codeBlock = input.codeBlocks[0];
  const trace = input.traces[0];
  if (!codeBlock || !trace) {
    throw new Error('The approved source was not compiled.');
  }
  const held = trace.events.find((event) => event.operation === TraceOperation.ADD);
  if (!held) {
    throw new Error('No compiled update to hold.');
  }
  const heldIndex = trace.events.indexOf(held);
  const before = trace.events.slice(0, heldIndex);
  const after = trace.events.slice(heldIndex + 1);
  const sourceRefs = codeBlock.sourceRefs;
  const createBeat = (eventId: string, beatId: string): NarrationBeat => ({
    beatId,
    text: 'Follow the current input and the total.',
    sourceRefs,
    traceEventId: eventId,
    stateView: TraceStateView.AFTER,
  });
  return LessonPlanSchema.parse({
    schemaVersion: '1.0',
    title: 'Follow a running total',
    objective: input.objective,
    audience: input.audience,
    language: input.language,
    courseRevisionId: input.courseRevisionId,
    sourcePacketHash: input.sourcePacketHash,
    scenes: [
      {
        sceneId: 'watch',
        title: 'Read the initial state',
        templateVersion: '1.0.0',
        layoutVariant: 'standard',
        sourceRefs,
        narration: before.map((event, index) =>
          createBeat(event.eventId, `watch-${String(index)}`),
        ),
        kind: LessonTemplateKind.CODE_TRACE,
        params: {
          codeBlockId: codeBlock.codeBlockId,
          traceId: trace.traceId,
          traceEventIds: before.map((event) => event.eventId),
          focusVariable: 'total',
        },
      },
      {
        sceneId: 'predict',
        title: 'Predict the next total',
        templateVersion: '1.0.0',
        layoutVariant: 'standard',
        sourceRefs,
        narration: [
          {
            beatId: 'question',
            text: 'What changes when this number is added?',
            sourceRefs,
            traceEventId: held.eventId,
            stateView: TraceStateView.BEFORE,
          },
        ],
        kind: LessonTemplateKind.CHECKPOINT,
        params: {
          checkpointId: 'checkpoint-1',
          traceId: trace.traceId,
          holdEventId: held.eventId,
          holdStateView: TraceStateView.BEFORE,
        },
      },
      {
        sceneId: 'continue',
        title: 'Continue the loop',
        templateVersion: '1.0.0',
        layoutVariant: 'standard',
        sourceRefs,
        narration: after.map((event, index) =>
          createBeat(event.eventId, `continue-${String(index)}`),
        ),
        kind: LessonTemplateKind.CODE_TRACE,
        params: {
          codeBlockId: codeBlock.codeBlockId,
          traceId: trace.traceId,
          traceEventIds: after.map((event) => event.eventId),
          focusVariable: 'total',
        },
      },
    ],
    checkpoints: [
      {
        checkpointId: 'checkpoint-1',
        sceneId: 'predict',
        phase: CheckpointPhase.PREDICT,
        kind: CheckpointKind.NUMERIC_TRACE,
        question: 'What is total after this addition?',
        sourceRefs,
        options: [],
        answerRef: {
          kind: 'traceValue',
          traceId: trace.traceId,
          eventId: held.eventId,
          variable: 'total',
          stateView: TraceStateView.AFTER,
        },
        hints: [
          { hintId: 'hint-1', text: 'Combine the old total and the current input.', sourceRefs },
        ],
        workedExplanation: [
          {
            beatId: 'worked',
            text: 'The running total is now two.',
            sourceRefs,
            traceEventId: held.eventId,
            stateView: TraceStateView.AFTER,
          },
        ],
      },
    ],
    reflectionPrompt: 'Why does the total persist between iterations?',
    teacherQuestions: [],
  });
}

/** Valid one-second PCM media exercises real decoding/rendering; it makes no speech-provider call. */
function createSilentWave(): Uint8Array<ArrayBuffer> {
  const sampleRate = 24000;
  const bytes = new Uint8Array(44 + sampleRate * 2);
  const view = new DataView(bytes.buffer);
  const writeTag = (offset: number, tag: string): void => {
    bytes.set(
      Array.from(tag, (character) => character.charCodeAt(0)),
      offset,
    );
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, sampleRate * 2, true);
  return bytes;
}

function readDetail(reply: GuidedLessonReply): GuidedLessonDetail {
  if (reply.kind !== 'detail') {
    throw new Error('Expected an authorized teacher detail.');
  }
  return reply.lesson;
}

it('completes approved source → generated script → real preview → released home lesson with private anchored notes', async () => {
  const { code, publication } = createApprovedPublication();
  const store = new MemoryGuidedLessonStore();
  store.publications.set(publication.courseId, publication);
  for (const userId of ['teacher', 'student', 'other']) {
    store.accesses.set(`${userId}:${publication.classId}`, {
      classId: publication.classId,
      teacherId: 'teacher',
      isTeacher: userId === 'teacher',
      enrolled: userId !== 'teacher',
      courseRevisionId: publication.courseId,
    });
  }
  const generate = vi.fn<LessonModel['generate']>().mockImplementation((request) => {
    if (request.stage === LessonModelStage.DRAFT) {
      const plan = createSyntheticPlan(request.input);
      const issues = validateLessonPlan(request.input, plan);
      if (issues.length > 0) {
        console.info(
          'guided-flow-plan-diagnostic',
          JSON.stringify(
            issues.map((issue) => ({
              criterion: issue.criterion,
              issueId: issue.issueId,
              observed: issue.observed,
            })),
          ),
        );
      }
      return Promise.resolve({
        result: { status: 'ready', plan },
        usage: { inputTokens: 100, outputTokens: 20 },
      });
    }
    const visual = request.stage === LessonModelStage.VISUAL_REVIEW;
    if (request.stage !== LessonModelStage.REVIEW && !visual) {
      return Promise.reject(new Error('Unexpected automatic provider stage.'));
    }
    const criteria = visual
      ? [
          ReviewCriterion.READABILITY,
          ReviewCriterion.HIERARCHY,
          ReviewCriterion.CONTINUITY,
          ReviewCriterion.TIMELINE,
          ReviewCriterion.ASSETS,
          ReviewCriterion.CHECKPOINT,
        ]
      : [
          ReviewCriterion.SOURCE_SUPPORT,
          ReviewCriterion.TRACE_CORRECTNESS,
          ReviewCriterion.CHECKPOINT,
        ];
    return Promise.resolve({
      result: {
        reviewedHash: visual ? hashLessonValue(request.manifest) : request.contentHash,
        verdict: visual ? ReviewVerdict.NEEDS_HUMAN_REVIEW : ReviewVerdict.PASS,
        checks: criteria.map((criterion) => ({
          criterion,
          status: ReviewCheckStatus.PASS,
          evidenceIds: [],
        })),
        issues: [],
        unassessed: visual
          ? [
              'Synthetic silence cannot establish pronunciation quality. Teacher approval is required.',
            ]
          : [],
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });
  const model: LessonModel = { countInput: () => Promise.resolve(100), generate };
  const wave = createSilentWave();
  const synthesize = vi.fn<LessonSpeech['synthesize']>().mockResolvedValue({
    bytes: wave,
    mimeType: 'audio/wav',
    durationMs: 1000,
    sampleRate: 24000,
    voiceConfigHash: hashLessonText('synthetic-silence-test'),
  });
  const service = new GuidedLessonService(
    store,
    model,
    { synthesize },
    new RemotionLessonRenderer(undefined, (event) => {
      console.info('guided-flow-render-diagnostic', JSON.stringify(event));
    }),
    () => new Date(),
    (event) => {
      console.info('guided-flow-stage-diagnostic', JSON.stringify(event));
    },
  );
  try {
    const teacherInput = await service.read('teacher', {
      action: 'teacherInput',
      classId: publication.classId,
    });
    expect(teacherInput.kind).toBe('teacherInput');
    const passages = buildPublicationLessonPassages(publication);
    const sourceRefs = passages.map((passage) => ({
      passageId: passage.passageId,
      startOffset: 0,
      endOffset: passage.text.length,
    }));
    let lesson = readDetail(
      await service.execute('teacher', {
        action: 'create',
        commandId: randomUUID(),
        classId: publication.classId,
        courseRevisionId: publication.courseId,
        conceptId: 'accumulator',
        objective: 'Explain how the running total changes.',
        audience: 'Beginning Python learners',
        language: LessonLanguage.EN,
        targetDurationSeconds: 120,
        passageIds: passages.map((passage) => passage.passageId),
        teacherInstructions: '',
        codeApproval: { code, sourceRefs, variantOfCodeBlockId: null },
        practiceCodeApproval: null,
      }),
    );
    expect(lesson.status).toBe(LessonStatus.NEEDS_TEACHER_INPUT);
    expect(lesson.input?.passages).toHaveLength(2);
    expect(JSON.stringify(lesson.input)).not.toContain(
      'This generated note is not source evidence.',
    );
    expect(generate).not.toHaveBeenCalled();
    const teacherBase = () => ({
      commandId: randomUUID(),
      classId: publication.classId,
      lessonId: lesson.id,
      expectedVersion: lesson.version,
    });
    const refresh = async (): Promise<void> => {
      lesson = readDetail(
        await service.read('teacher', {
          action: 'detail',
          classId: publication.classId,
          lessonId: lesson.id,
        }),
      );
    };
    const advanceTo = async (status: LessonStatus): Promise<void> => {
      for (let stages = 0; stages < 40; stages += 1) {
        await service.prepareNextLesson();
        await refresh();
        if (lesson.status === status) {
          return;
        }
        if (
          lesson.status === LessonStatus.FAILED ||
          lesson.status === LessonStatus.USAGE_UNCERTAIN ||
          lesson.status === LessonStatus.BUDGET_BLOCKED
        ) {
          throw new Error(`Lesson stopped at ${lesson.status}: ${lesson.error ?? 'no diagnostic'}`);
        }
      }
      throw new Error(`Lesson never reached ${status}.`);
    };
    lesson = readDetail(await service.execute('teacher', { action: 'start', ...teacherBase() }));
    await advanceTo(LessonStatus.AWAITING_SCRIPT_APPROVAL);
    if (!lesson.contentHash || !lesson.plan) {
      throw new Error('Generated script missing.');
    }
    expect(lesson.scriptApproved).toBe(false);
    expect(synthesize).not.toHaveBeenCalled();
    lesson = readDetail(
      await service.execute('teacher', {
        action: 'approveScript',
        ...teacherBase(),
        contentHash: lesson.contentHash,
        acknowledgedSceneIds: lesson.plan.scenes.map((scene) => scene.sceneId),
      }),
    );
    lesson = readDetail(await service.execute('teacher', { action: 'render', ...teacherBase() }));
    await advanceTo(LessonStatus.PREVIEW_READY);
    if (!lesson.manifest || !lesson.contentHash) {
      throw new Error('Measured render missing.');
    }
    expect(lesson.manifest.evidence.some((item) => item.kind === 'frame')).toBe(true);
    expect(lesson.manifest.evidence.some((item) => item.kind === 'geometry')).toBe(true);
    expect(lesson.visualReview?.verdict).toBe(ReviewVerdict.NEEDS_HUMAN_REVIEW);
    expect(lesson.previewApproved).toBe(false);
    const visualRequest = generate.mock.calls.find(
      ([request]) => request.stage === LessonModelStage.VISUAL_REVIEW,
    )?.[0];
    expect(visualRequest?.evidence.some((artifact) => artifact.kind === 'frame')).toBe(true);
    expect(
      visualRequest?.evidence.some(
        (artifact) => artifact.kind === 'source' && artifact.mimeType === 'application/json',
      ),
    ).toBe(true);
    const pendingPreview = await service.read('teacher', {
      action: 'preview',
      classId: publication.classId,
      lessonId: lesson.id,
      sceneId: 'predict',
      phase: LessonPhase.PREDICT,
    });
    const workedPreview = await service.read('teacher', {
      action: 'preview',
      classId: publication.classId,
      lessonId: lesson.id,
      sceneId: 'predict',
      phase: LessonPhase.WORKED,
    });
    expect(
      pendingPreview.kind === 'projection' &&
        pendingPreview.projection.visibleTraceStates.every(
          (state) => state.stateView === TraceStateView.BEFORE,
        ),
    ).toBe(true);
    expect(workedPreview.kind === 'projection' && workedPreview.projection.phase).toBe(
      LessonPhase.WORKED,
    );
    const manifestHash = hashLessonValue(lesson.manifest);
    lesson = readDetail(
      await service.execute('teacher', {
        action: 'approvePreview',
        ...teacherBase(),
        renderManifestHash: manifestHash,
        acknowledgedEvidenceIds: lesson.manifest.evidence.map((item) => item.evidenceId),
      }),
    );
    if (!lesson.contentHash) {
      throw new Error('Approved content hash missing.');
    }
    lesson = readDetail(
      await service.execute('teacher', {
        action: 'release',
        ...teacherBase(),
        contentHash: lesson.contentHash,
        renderManifestHash: manifestHash,
      }),
    );
    const releaseId = lesson.releaseId;
    if (!releaseId) {
      throw new Error('Release was not created.');
    }
    expect(lesson.status).toBe(LessonStatus.RELEASED);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(synthesize).toHaveBeenCalledTimes(lesson.manifest?.speechArtifacts.length ?? 0);
    expect(lesson.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 60,
      generationAttempts: 3,
    });
    expect(
      [...store.budgets.values()]
        .flatMap((budget) => budget.reservations)
        .every((reservation) => reservation.state === 'settled'),
    ).toBe(true);
    const studentBase = (expectedProgressVersion: number) => ({
      commandId: randomUUID(),
      classId: publication.classId,
      lessonId: lesson.id,
      releaseId,
      expectedProgressVersion,
    });
    const first = await service.read('student', {
      action: 'projection',
      classId: publication.classId,
      releaseId,
    });
    if (first.kind !== 'projection') {
      throw new Error('Home playback projection missing.');
    }
    const watchEnd = Math.max(
      ...first.projection.narrationCues.map((cue) => cue.endFrame),
      ...first.projection.visualCues.map((cue) => cue.endFrame),
    );
    const pending = await service.execute('student', {
      action: 'progress',
      ...studentBase(0),
      sceneId: 'watch',
      intent: 'watchComplete',
      frame: watchEnd - 1,
      reflection: '',
    });
    expect(pending.kind === 'projection' && pending.projection.phase).toBe(LessonPhase.PREDICT);
    expect(JSON.stringify(pending)).not.toContain('answerRef');
    const workedAudioId =
      workedPreview.kind === 'projection'
        ? workedPreview.projection.narrationCues[0]?.artifactId
        : undefined;
    if (!workedAudioId) {
      throw new Error('Worked explanation media missing.');
    }
    await expect(
      service.readArtifact('student', {
        classId: publication.classId,
        lessonId: lesson.id,
        releaseId,
        artifactId: workedAudioId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const note = {
      noteId: randomUUID(),
      expectedVersion: 0,
      anchor: {
        releaseId,
        sceneId: 'predict',
        phase: LessonPhase.PREDICT,
        frame: 3,
        traceEventId: null,
        sourceRef: null,
      },
      text: 'Remember to predict the next total.',
      isBookmark: true,
    };
    await service.execute('student', { action: 'saveNote', ...studentBase(1), note });
    expect(
      await service.read('other', { action: 'notes', classId: publication.classId, releaseId }),
    ).toEqual({ kind: 'notes', notes: [] });
    const hint = await service.execute('student', {
      action: 'help',
      ...studentBase(2),
      sceneId: 'predict',
      message: 'Tell me the answer.',
    });
    expect(hint.kind).toBe('hint');
    expect(generate).toHaveBeenCalledTimes(3);
    const correct = await service.execute('student', {
      action: 'attempt',
      ...studentBase(3),
      checkpointId: 'checkpoint-1',
      answer: { kind: 'number', value: 2 },
    });
    expect(correct.kind === 'projection' && correct.projection.phase).toBe(LessonPhase.WORKED);
    expect(correct.kind === 'projection' && correct.projection.checkpoint?.state).toBe('assisted');
    expect(
      (
        await service.readArtifact('student', {
          classId: publication.classId,
          lessonId: lesson.id,
          releaseId,
          artifactId: workedAudioId,
        })
      ).bytes,
    ).toEqual(wave);
    const revisited = await service.execute('student', {
      action: 'progress',
      ...studentBase(4),
      sceneId: 'predict',
      intent: 'revisit',
      noteId: note.noteId,
      frame: 0,
      reflection: '',
    });
    expect(revisited.kind === 'projection' && revisited.projection.phase).toBe(LessonPhase.PREDICT);
    expect(revisited.kind === 'projection' && revisited.projection.frame).toBe(3);
  } finally {
    service.close();
  }
}, 180000);
