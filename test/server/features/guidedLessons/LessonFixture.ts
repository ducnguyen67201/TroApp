import { createHash } from 'node:crypto';
import {
  LessonInputSchema,
  LessonPlanSchema,
  RenderManifestSchema,
  type LessonPlan,
  type NarrationBeat,
} from '#contracts/GuidedLessons.js';
import { compileAccumulator } from '../../../../src/server/features/guidedLessons/domain/CompileAccumulator.js';
import type {
  ProjectionProgress,
  ProjectionRecord,
} from '../../../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashValue(value: unknown): string {
  return hashText(JSON.stringify(value));
}

export function createLessonFixture() {
  const text = 'A loop adds the current number to the running total.';
  const sourceRefs = [{ passageId: 'passage-1', startOffset: 0, endOffset: text.length }];
  const compiled = compileAccumulator(
    {
      codeBlockId: 'base-code',
      traceId: 'base-trace',
      approvalReceiptId: 'teacher-receipt',
      variantOfCodeBlockId: null,
      code: 'numbers = [2, 4, 6]\ntotal = 0\nfor number in numbers:\n    total = total + number\nprint(total)',
      sourceRefs,
    },
    hashText,
  );
  const input = LessonInputSchema.parse({
    schemaVersion: '1.0',
    requestId: 'request-1',
    classId: 'class-1',
    courseRevisionId: 'course-1',
    conceptId: 'accumulator',
    objective: 'Explain how each loop step changes the total.',
    audience: 'Beginning Python learners',
    language: 'en',
    targetDurationSeconds: 120,
    sourcePacketHash: hashText('packet'),
    passages: [
      {
        passageId: 'passage-1',
        materialId: 'material-1',
        publicationId: 'course-1',
        ownerSourceId: 'source-1',
        kind: 'sourceText',
        correctsPassageIds: [],
        pageId: 'page-1',
        sourceDigest: hashText(text),
        textDigest: hashText(text),
        text,
      },
    ],
    codeBlocks: [compiled.codeBlock],
    traces: [compiled.trace],
    assets: [],
    templates: [
      {
        templateId: 'codeTrace',
        templateVersion: '1.0.0',
        supportedLayoutVariants: ['standard', 'wideCode'],
        contentRules: ['Essential text is at least 48 pixels.'],
      },
      {
        templateId: 'checkpoint',
        templateVersion: '1.0.0',
        supportedLayoutVariants: ['standard', 'wideCode'],
        contentRules: ['A pending checkpoint holds the before state.'],
      },
    ],
    teacherAnswerKeys: [],
    teacherInstructions: '',
  });
  const held = compiled.trace.events.find((event) => event.operation === 'add');
  if (!held) {
    throw new Error('Fixture has no addition.');
  }
  const heldIndex = compiled.trace.events.indexOf(held);
  const beforeEvents = compiled.trace.events.slice(0, heldIndex);
  const afterEvents = compiled.trace.events.slice(heldIndex + 1);
  const createBeat = (eventId: string, beatId: string): NarrationBeat => ({
    beatId,
    text: 'Follow the current input and the running total.',
    sourceRefs,
    traceEventId: eventId,
    stateView: 'after',
  });
  const plan: LessonPlan = LessonPlanSchema.parse({
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
        narration: beforeEvents.map((event, index) =>
          createBeat(event.eventId, `watch-${String(index)}`),
        ),
        kind: 'codeTrace',
        params: {
          codeBlockId: compiled.codeBlock.codeBlockId,
          traceId: compiled.trace.traceId,
          traceEventIds: beforeEvents.map((event) => event.eventId),
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
            text: 'What happens when the current number is added?',
            sourceRefs,
            traceEventId: held.eventId,
            stateView: 'before',
          },
        ],
        kind: 'checkpoint',
        params: {
          checkpointId: 'checkpoint-1',
          traceId: compiled.trace.traceId,
          holdEventId: held.eventId,
          holdStateView: 'before',
        },
      },
      {
        sceneId: 'continue',
        title: 'Continue the loop',
        templateVersion: '1.0.0',
        layoutVariant: 'standard',
        sourceRefs,
        narration: afterEvents.map((event, index) =>
          createBeat(event.eventId, `continue-${String(index)}`),
        ),
        kind: 'codeTrace',
        params: {
          codeBlockId: compiled.codeBlock.codeBlockId,
          traceId: compiled.trace.traceId,
          traceEventIds: afterEvents.map((event) => event.eventId),
          focusVariable: 'total',
        },
      },
    ],
    checkpoints: [
      {
        checkpointId: 'checkpoint-1',
        sceneId: 'predict',
        phase: 'predict',
        kind: 'numericTrace',
        question: 'What is total after this addition?',
        sourceRefs,
        options: [],
        answerRef: {
          kind: 'traceValue',
          traceId: compiled.trace.traceId,
          eventId: held.eventId,
          variable: 'total',
          stateView: 'after',
        },
        hints: [
          { hintId: 'hint-1', text: 'Combine the old total with the current input.', sourceRefs },
        ],
        workedExplanation: [
          {
            beatId: 'worked',
            text: 'The running total is now two.',
            sourceRefs,
            traceEventId: held.eventId,
            stateView: 'after',
          },
        ],
      },
    ],
    reflectionPrompt: 'Why does the running total persist between iterations?',
    teacherQuestions: [],
  });
  let cursor = 900;
  const timedBeats = plan.scenes.flatMap((scene) => {
    const checkpoint = plan.checkpoints.find((candidate) => candidate.sceneId === scene.sceneId);
    return [
      ...scene.narration.map((beat) => ({
        beat,
        sceneId: scene.sceneId,
        phase: checkpoint?.phase ?? 'watch',
      })),
      ...(checkpoint?.workedExplanation.map((beat) => ({
        beat,
        sceneId: scene.sceneId,
        phase: 'worked',
      })) ?? []),
    ];
  });
  const manifest = RenderManifestSchema.parse({
    schemaVersion: '1.0',
    revisionId: 'revision-1',
    contentHash: hashText('content'),
    inputPacketHash: input.sourcePacketHash,
    adjustmentsHash: null,
    rendererVersion: '1.0.0',
    compositionBundleHash: hashText('composition'),
    fontBundleHash: hashText('font'),
    templateVersions: [
      { templateId: 'codeTrace', version: '1.0.0' },
      { templateId: 'checkpoint', version: '1.0.0' },
    ],
    width: 1920,
    height: 1080,
    fps: 30,
    speechArtifacts: timedBeats.map(({ beat }) => ({
      artifactId: `audio-${beat.beatId}`,
      beatId: beat.beatId,
      contentHash: hashText('content'),
      textHash: hashText(beat.text),
      audioDigest: hashText('audio'),
      durationMs: 1000,
      byteLength: 4,
      mimeType: 'audio/wav',
      sampleRateHz: 24000,
      voiceConfigHash: hashText('voice'),
    })),
    cues: timedBeats.map(({ beat, sceneId, phase }) => {
      const startFrame = cursor;
      cursor += 30;
      return {
        cueId: `cue-${beat.beatId}`,
        sceneId,
        phase,
        beatId: beat.beatId,
        audioArtifactId: `audio-${beat.beatId}`,
        startFrame,
        endFrame: cursor,
        traceEventId: beat.traceEventId,
        stateView: beat.stateView,
      };
    }),
    evidence: [
      {
        evidenceId: 'evidence-1',
        artifactId: 'evidence-artifact',
        kind: 'validation',
        digest: hashText('evidence'),
        sceneId: null,
        frame: null,
        phase: null,
      },
    ],
    sourceAssetDigests: [],
  });
  const record: ProjectionRecord = {
    input,
    plan,
    manifest,
    adjustments: null,
    revisionId: 'revision-1',
    contentHash: hashText('content'),
    releaseId: 'release-1',
  };
  const progress: ProjectionProgress = {
    version: 0,
    sceneId: 'watch',
    revealed: [],
    attempted: [],
    independent: [],
    hinted: [],
    hintIds: [],
    frame: 0,
    reflection: '',
  };
  return { input, plan, record, progress, held, hashValue };
}
