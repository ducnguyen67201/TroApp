import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { MaterialPublicationSchema } from '#contracts/ClassroomMaterials.js';
import {
  GuidedLessonAction,
  LearnerProgressIntent,
  LessonLanguage,
  LessonPhase,
  LessonStatus,
  LessonTemplateKind,
  ReviewCheckStatus,
  ReviewCriterion,
  ReviewVerdict,
  SourcePassageKind,
  type GuidedLessonDetail,
  type GuidedLessonReply,
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
import { MemoryGuidedLessonStore } from './MemoryGuidedLessonStore.js';
import { createSourceLessonPlan } from './SourceLessonFixture.js';

function createSciencePublication() {
  const materialId = randomUUID();
  const pageId = randomUUID();
  const text =
    'Evaporation changes liquid water into water vapour. Cooling can condense water vapour into liquid water.';
  return MaterialPublicationSchema.parse({
    classId: randomUUID(),
    courseId: randomUUID(),
    teacherInstructions: '',
    sources: [
      {
        id: materialId,
        name: 'Water changes',
        bytes: text.length,
        digest: hashLessonText(text),
        url: null,
      },
    ],
    draft: {
      summary: 'Changes between liquid water and water vapour.',
      questions: [],
      sections: [
        {
          id: randomUUID(),
          title: 'Water changes',
          instruction: 'Connect the changes.',
          sourcePageIds: [pageId],
        },
      ],
      pages: [
        {
          id: pageId,
          materialId,
          location: 'Page 1',
          extractedText: text,
          preparedNote: 'Unapproved generated summary must stay out of the lesson.',
          teacherNote: 'Water vapour is invisible; visible mist consists of small liquid droplets.',
          warnings: [],
        },
      ],
    },
  });
}

/** Local PCM exercises real media decoding without dispatching a speech provider. */
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
  view.setUint32(40, bytes.length - 44, true);
  return bytes;
}

function readDetail(reply: GuidedLessonReply): GuidedLessonDetail {
  if (reply.kind !== 'detail') {
    throw new Error('Expected teacher detail.');
  }
  return reply.lesson;
}

function readPlayback(reply: GuidedLessonReply) {
  if (reply.kind !== 'projection') {
    throw new Error('Expected learner playback.');
  }
  return reply;
}

it('renders and releases a grounded non-Python lesson with approvals, help and reflection but no invented quiz', async () => {
  const publication = createSciencePublication();
  const store = new MemoryGuidedLessonStore();
  store.publications.set(publication.courseId, publication);
  for (const userId of ['teacher', 'student']) {
    store.accesses.set(`${userId}:${publication.classId}`, {
      classId: publication.classId,
      teacherId: 'teacher',
      isTeacher: userId === 'teacher',
      enrolled: userId === 'student',
      courseRevisionId: publication.courseId,
    });
  }
  const generate = vi.fn<LessonModel['generate']>().mockImplementation((request) => {
    const usage = { inputTokens: 100, outputTokens: 20 };
    if (request.stage === LessonModelStage.DRAFT) {
      return Promise.resolve({
        result: { status: 'ready', plan: createSourceLessonPlan(request.input) },
        usage,
      });
    }
    if (request.stage === LessonModelStage.HELP) {
      const passage = request.helpContext?.sourcePassages[0];
      if (!passage) {
        throw new Error('Source-based help needs an authorized source reference.');
      }
      const sourceRef = {
        passageId: passage.passageId,
        startOffset: 0,
        endOffset: passage.text.length,
      };
      return Promise.resolve({
        result: {
          kind: 'answer',
          text: 'Cooling can condense water vapour into liquid water.',
          sourceRefs: [sourceRef],
        },
        usage,
      });
    }
    const visual = request.stage === LessonModelStage.VISUAL_REVIEW;
    if (request.stage !== LessonModelStage.REVIEW && !visual) {
      throw new Error('Unexpected automatic provider stage.');
    }
    const criteria = visual
      ? [
          ReviewCriterion.READABILITY,
          ReviewCriterion.HIERARCHY,
          ReviewCriterion.CONTINUITY,
          ReviewCriterion.TIMELINE,
          ReviewCriterion.ASSETS,
        ]
      : [ReviewCriterion.SOURCE_SUPPORT];
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
        unassessed: visual ? ['Synthetic silence requires teacher pronunciation review.'] : [],
      },
      usage,
    });
  });
  const synthesize = vi.fn<LessonSpeech['synthesize']>().mockResolvedValue({
    bytes: createSilentWave(),
    mimeType: 'audio/wav',
    durationMs: 1000,
    sampleRate: 24000,
    voiceConfigHash: hashLessonText('local-silence'),
  });
  const service = new GuidedLessonService(
    store,
    { countInput: () => Promise.resolve(100), generate },
    { synthesize },
    new RemotionLessonRenderer(),
  );
  try {
    const section = publication.draft.sections[0];
    if (!section) {
      throw new Error('The publication fixture needs an approved section.');
    }
    const passages = buildPublicationLessonPassages(publication);
    let lesson = readDetail(
      await service.execute('teacher', {
        action: GuidedLessonAction.CREATE,
        commandId: randomUUID(),
        classId: publication.classId,
        courseRevisionId: publication.courseId,
        conceptId: section.id,
        objective: 'Explain evaporation and condensation.',
        audience: 'Beginning science learners',
        language: LessonLanguage.EN,
        targetDurationSeconds: 180,
        passageIds: passages.map((passage) => passage.passageId),
        teacherInstructions: 'Use the selected science source.',
        codeApproval: null,
        practiceCodeApproval: null,
      }),
    );
    expect(lesson.input).toMatchObject({
      codeBlocks: [],
      traces: [],
      teacherAnswerKeys: [],
      templates: [{ templateId: LessonTemplateKind.SOURCE_EXPLANATION }],
    });
    expect(
      lesson.input?.passages.some((passage) => passage.kind === SourcePassageKind.PAGE_CORRECTION),
    ).toBe(true);
    expect(JSON.stringify(lesson.input)).not.toContain('Unapproved generated summary');
    expect(generate).not.toHaveBeenCalled();
    const teacherBase = () => ({
      commandId: randomUUID(),
      classId: publication.classId,
      lessonId: lesson.id,
      expectedVersion: lesson.version,
    });
    const advanceTo = async (status: LessonStatus): Promise<void> => {
      for (let stages = 0; stages < 40; stages += 1) {
        await service.prepareNextLesson();
        lesson = readDetail(
          await service.read('teacher', {
            action: 'detail',
            classId: publication.classId,
            lessonId: lesson.id,
          }),
        );
        if (lesson.status === status) {
          return;
        }
        if (
          [LessonStatus.FAILED, LessonStatus.USAGE_UNCERTAIN, LessonStatus.BUDGET_BLOCKED].some(
            (failure) => failure === lesson.status,
          )
        ) {
          throw new Error(
            `Source lesson stopped at ${lesson.status}: ${lesson.error ?? 'no diagnostic'}`,
          );
        }
      }
      throw new Error(`Source lesson did not reach ${status}.`);
    };
    lesson = readDetail(
      await service.execute('teacher', { action: GuidedLessonAction.START, ...teacherBase() }),
    );
    await advanceTo(LessonStatus.AWAITING_SCRIPT_APPROVAL);
    if (!lesson.plan || !lesson.contentHash) {
      throw new Error('Source script missing.');
    }
    expect(lesson.plan.checkpoints).toEqual([]);
    expect(
      lesson.plan.scenes.every((scene) => scene.kind === LessonTemplateKind.SOURCE_EXPLANATION),
    ).toBe(true);
    expect(synthesize).not.toHaveBeenCalled();
    await expect(
      service.execute('teacher', { action: GuidedLessonAction.RENDER, ...teacherBase() }),
    ).rejects.toMatchObject({ code: 'invalidPlan' });
    lesson = readDetail(
      await service.execute('teacher', {
        action: GuidedLessonAction.APPROVE_SCRIPT,
        ...teacherBase(),
        contentHash: lesson.contentHash,
        acknowledgedSceneIds: lesson.plan.scenes.map((scene) => scene.sceneId),
      }),
    );
    lesson = readDetail(
      await service.execute('teacher', { action: GuidedLessonAction.RENDER, ...teacherBase() }),
    );
    await advanceTo(LessonStatus.PREVIEW_READY);
    if (!lesson.manifest || !lesson.contentHash) {
      throw new Error('Source render missing.');
    }
    expect(lesson.manifest.evidence.some((item) => item.kind === 'frame')).toBe(true);
    expect(lesson.manifest.evidence.some((item) => item.kind === 'geometry')).toBe(true);
    expect(
      lesson.manifest.cues.every(
        (cue) => cue.phase === LessonPhase.WATCH && cue.traceEventId === null,
      ),
    ).toBe(true);
    const preview = readPlayback(
      await service.read('teacher', {
        action: 'preview',
        classId: publication.classId,
        lessonId: lesson.id,
      }),
    );
    expect(preview.projection).toMatchObject({
      presentation: { kind: LessonTemplateKind.SOURCE_EXPLANATION },
      visibleTraceStates: [],
      visualCues: [],
      checkpoint: null,
    });
    const manifestHash = hashLessonValue(lesson.manifest);
    await expect(
      service.execute('teacher', {
        action: GuidedLessonAction.RELEASE,
        ...teacherBase(),
        contentHash: lesson.contentHash,
        renderManifestHash: manifestHash,
      }),
    ).rejects.toMatchObject({ code: 'invalidPlan' });
    lesson = readDetail(
      await service.execute('teacher', {
        action: GuidedLessonAction.APPROVE_PREVIEW,
        ...teacherBase(),
        renderManifestHash: manifestHash,
        acknowledgedEvidenceIds: lesson.manifest.evidence.map((item) => item.evidenceId),
      }),
    );
    if (!lesson.contentHash) {
      throw new Error('Approved source content hash missing.');
    }
    lesson = readDetail(
      await service.execute('teacher', {
        action: GuidedLessonAction.RELEASE,
        ...teacherBase(),
        contentHash: lesson.contentHash,
        renderManifestHash: manifestHash,
      }),
    );
    const releaseId = lesson.releaseId;
    if (!releaseId) {
      throw new Error('Source release missing.');
    }
    let playback = readPlayback(
      await service.read('student', {
        action: 'projection',
        classId: publication.classId,
        releaseId,
      }),
    );
    expect(playback.projection.phase).toBe(LessonPhase.WATCH);
    const studentBase = () => ({
      commandId: randomUUID(),
      classId: publication.classId,
      lessonId: lesson.id,
      releaseId,
      expectedProgressVersion: playback.projection.progressVersion,
    });
    await expect(
      service.execute('student', {
        action: GuidedLessonAction.ATTEMPT,
        ...studentBase(),
        checkpointId: 'invented-quiz',
        answer: { kind: 'number', value: 2 },
      }),
    ).rejects.toMatchObject({ code: 'invalidPlan' });
    const help = await service.execute('student', {
      action: GuidedLessonAction.HELP,
      ...studentBase(),
      sceneId: playback.projection.sceneId,
      message: 'What does cooling do?',
      history: [],
    });
    expect(help).toMatchObject({ kind: 'help', result: { kind: 'answer' } });
    const helpRequest = generate.mock.calls.find(
      ([request]) => request.stage === LessonModelStage.HELP,
    )?.[0];
    expect(helpRequest?.helpContext?.visibleProjection.presentation.kind).toBe(
      LessonTemplateKind.SOURCE_EXPLANATION,
    );
    for (let scenes = 0; scenes < 2; scenes += 1) {
      const endFrame = Math.max(1, ...playback.projection.narrationCues.map((cue) => cue.endFrame));
      playback = readPlayback(
        await service.execute('student', {
          action: GuidedLessonAction.PROGRESS,
          ...studentBase(),
          sceneId: playback.projection.sceneId,
          intent: LearnerProgressIntent.WATCH_COMPLETE,
          frame: endFrame - 1,
          reflection: '',
        }),
      );
    }
    expect(playback.projection.phase).toBe(LessonPhase.REFLECT);
    playback = readPlayback(
      await service.execute('student', {
        action: GuidedLessonAction.PROGRESS,
        ...studentBase(),
        sceneId: playback.projection.sceneId,
        intent: LearnerProgressIntent.REFLECT,
        frame: 0,
        reflection: 'Cooling turns water vapour back into liquid water.',
      }),
    );
    expect([...store.progress.values()][0]?.reflection).toBe(
      'Cooling turns water vapour back into liquid water.',
    );
    expect(playback.projection.checkpoint).toBeNull();
    expect(generate).toHaveBeenCalledTimes(4);
  } finally {
    service.close();
  }
}, 180000);
