import {
  LessonInputSchema,
  LessonPlanSchema,
  RenderManifestSchema,
  SourcePassageKind,
  type LessonInput,
  type LessonPlan,
} from '#contracts/GuidedLessons.js';
import { hashLessonValue } from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import type {
  ProjectionProgress,
  ProjectionRecord,
} from '../../../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';
import { hashText } from './LessonFixture.js';

export function createSourceLessonPlan(input: LessonInput): LessonPlan {
  const passage = input.passages.find(
    (candidate) => candidate.kind === SourcePassageKind.SOURCE_TEXT,
  );
  if (!passage || passage.text.trim().length === 0) {
    throw new Error('The source lesson fixture needs a nonempty passage.');
  }
  const separator = passage.text.indexOf('. ') + 1;
  const firstEnd = Math.min(separator > 0 ? separator : passage.text.length, 180);
  const secondStart = firstEnd < passage.text.length ? firstEnd : 0;
  const correctionRefs = input.passages
    .filter(
      (candidate) =>
        candidate.kind !== SourcePassageKind.SOURCE_TEXT &&
        candidate.correctsPassageIds.includes(passage.passageId),
    )
    .map((correction) => ({
      passageId: correction.passageId,
      startOffset: 0,
      endOffset: correction.text.length,
    }));
  return LessonPlanSchema.parse({
    schemaVersion: '1.0',
    title: 'Explain the source',
    objective: input.objective,
    audience: input.audience,
    language: input.language,
    courseRevisionId: input.courseRevisionId,
    sourcePacketHash: input.sourcePacketHash,
    scenes: [
      {
        sceneId: 'source-introduction',
        title: 'Read the first idea',
        startOffset: 0,
        endOffset: firstEnd,
      },
      {
        sceneId: 'source-connection',
        title: 'Connect the ideas',
        startOffset: secondStart,
        endOffset: Math.min(secondStart + 180, passage.text.length),
      },
    ].map(({ sceneId, title, startOffset, endOffset }) => {
      const text = passage.text.slice(startOffset, endOffset).trim();
      const sourceRefs = [
        { passageId: passage.passageId, startOffset, endOffset },
        ...correctionRefs,
      ];
      return {
        sceneId,
        title,
        templateVersion: '1.0.0',
        layoutVariant: 'standard',
        sourceRefs,
        narration: [
          { beatId: `${sceneId}-beat`, text, sourceRefs, traceEventId: null, stateView: null },
        ],
        kind: 'sourceExplanation',
        params: { points: [{ pointId: `${sceneId}-point`, text, sourceRefs }] },
      };
    }),
    checkpoints: [],
    reflectionPrompt: 'How do the two ideas relate to each other?',
    teacherQuestions: [],
  });
}

/** A non-programming source packet with narrated, grounded scenes and no grading keys. */
export function createSourceLessonFixture() {
  const text =
    'Evaporation changes liquid water into water vapour. Cooling can condense water vapour into liquid water.';
  const input: LessonInput = LessonInputSchema.parse({
    schemaVersion: '1.0',
    requestId: 'water-request',
    classId: 'class-1',
    courseRevisionId: 'course-1',
    conceptId: 'water-changes',
    objective: 'Explain two changes between liquid water and water vapour.',
    audience: 'Beginning science learners',
    language: 'en',
    targetDurationSeconds: 60,
    sourcePacketHash: hashText('water-packet'),
    passages: [
      {
        passageId: 'water-source',
        materialId: 'water-material',
        publicationId: 'course-1',
        ownerSourceId: 'water-owner',
        kind: 'sourceText',
        correctsPassageIds: [],
        pageId: 'water-page',
        sourceDigest: hashText(text),
        textDigest: hashText(text),
        text,
      },
    ],
    codeBlocks: [],
    traces: [],
    assets: [],
    templates: [
      {
        templateId: 'sourceExplanation',
        templateVersion: '1.0.0',
        supportedLayoutVariants: ['standard'],
        contentRules: ['Explain only the cited source with readable text and narration.'],
      },
    ],
    teacherAnswerKeys: [],
    teacherInstructions: '',
  });
  const plan = createSourceLessonPlan(input);
  const contentHash = hashLessonValue({ input, plan });
  const manifest = RenderManifestSchema.parse({
    schemaVersion: '1.0',
    revisionId: 'source-revision-1',
    contentHash,
    inputPacketHash: input.sourcePacketHash,
    adjustmentsHash: null,
    rendererVersion: '1.0.0',
    compositionBundleHash: hashText('composition'),
    fontBundleHash: hashText('font'),
    templateVersions: [{ templateId: 'sourceExplanation', version: '1.0.0' }],
    width: 1920,
    height: 1080,
    fps: 30,
    speechArtifacts: plan.scenes.flatMap((scene) =>
      scene.narration.map((beat) => ({
        artifactId: `audio-${beat.beatId}`,
        beatId: beat.beatId,
        contentHash,
        textHash: hashText(beat.text),
        audioDigest: hashText('audio'),
        durationMs: 1000,
        byteLength: 4,
        mimeType: 'audio/wav',
        sampleRateHz: 24000,
        voiceConfigHash: hashText('voice'),
      })),
    ),
    cues: plan.scenes.flatMap((scene, index) =>
      scene.narration.map((beat) => ({
        cueId: `cue-${beat.beatId}`,
        sceneId: scene.sceneId,
        phase: 'watch',
        beatId: beat.beatId,
        audioArtifactId: `audio-${beat.beatId}`,
        startFrame: index * 30,
        endFrame: (index + 1) * 30,
        traceEventId: null,
        stateView: null,
      })),
    ),
    evidence: [
      {
        evidenceId: 'source-evidence-1',
        artifactId: 'source-evidence-artifact',
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
    revisionId: manifest.revisionId,
    contentHash,
    releaseId: 'source-release-1',
  };
  const progress: ProjectionProgress = {
    version: 0,
    sceneId: 'source-introduction',
    revealed: [],
    attempted: [],
    independent: [],
    hinted: [],
    hintIds: [],
    frame: 0,
    reflection: '',
  };
  return { input, plan, record, progress, hashValue: hashLessonValue };
}
