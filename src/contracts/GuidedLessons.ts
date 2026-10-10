import { z } from 'zod';
import { ClassSchema } from './Classroom.js';

/** Canonical bounded guided-lesson wire and persistence contracts. Authorization and reference validation remain server responsibilities. */
export const SourcePassageKind = {
  SOURCE_TEXT: 'sourceText',
  PAGE_CORRECTION: 'pageCorrection',
  DOCUMENT_CORRECTION: 'documentCorrection',
} as const;

export type SourcePassageKind = (typeof SourcePassageKind)[keyof typeof SourcePassageKind];

export const TraceOperation = {
  INITIALIZE: 'initialize',
  BIND_ITEM: 'bindItem',
  ADD: 'add',
  OUTPUT: 'output',
} as const;

export type TraceOperation = (typeof TraceOperation)[keyof typeof TraceOperation];

export const LessonAssetKind = {
  SOURCE_FIGURE: 'sourceFigure',
  REFERENCE_FRAME: 'referenceFrame',
} as const;

export type LessonAssetKind = (typeof LessonAssetKind)[keyof typeof LessonAssetKind];

export const LessonTemplateKind = {
  CODE_TRACE: 'codeTrace',
  ANNOTATED_SOURCE: 'annotatedSource',
  CHECKPOINT: 'checkpoint',
} as const;

export type LessonTemplateKind = (typeof LessonTemplateKind)[keyof typeof LessonTemplateKind];

export const LessonLanguage = {
  EN: 'en',
  VI: 'vi',
} as const;

export type LessonLanguage = (typeof LessonLanguage)[keyof typeof LessonLanguage];

export const TraceStateView = {
  BEFORE: 'before',
  AFTER: 'after',
} as const;

export type TraceStateView = (typeof TraceStateView)[keyof typeof TraceStateView];

export const CheckpointPhase = {
  PREDICT: 'predict',
  TRY: 'try',
} as const;

export type CheckpointPhase = (typeof CheckpointPhase)[keyof typeof CheckpointPhase];

export const CheckpointKind = {
  NUMERIC_TRACE: 'numericTrace',
  SOURCE_CHOICE: 'sourceChoice',
} as const;

export type CheckpointKind = (typeof CheckpointKind)[keyof typeof CheckpointKind];

export const ReviewCriterion = {
  SOURCE_SUPPORT: 'sourceSupport',
  TRACE_CORRECTNESS: 'traceCorrectness',
  CHECKPOINT: 'checkpoint',
  READABILITY: 'readability',
  HIERARCHY: 'hierarchy',
  CONTINUITY: 'continuity',
  STYLE: 'style',
  TIMELINE: 'timeline',
  ASSETS: 'assets',
  PRONUNCIATION: 'pronunciation',
  MOTION: 'motion',
} as const;

export type ReviewCriterion = (typeof ReviewCriterion)[keyof typeof ReviewCriterion];

export const ReviewSeverity = {
  BLOCKER: 'blocker',
  MAJOR: 'major',
  MINOR: 'minor',
} as const;

export type ReviewSeverity = (typeof ReviewSeverity)[keyof typeof ReviewSeverity];

export const ReviewVerdict = {
  PASS: 'pass',
  FIX: 'fix',
  NEEDS_TEACHER_INPUT: 'needsTeacherInput',
  NEEDS_HUMAN_REVIEW: 'needsHumanReview',
} as const;

export type ReviewVerdict = (typeof ReviewVerdict)[keyof typeof ReviewVerdict];

export const ReviewCheckStatus = {
  PASS: 'pass',
  FIX: 'fix',
  NOT_ASSESSED: 'notAssessed',
} as const;

export type ReviewCheckStatus = (typeof ReviewCheckStatus)[keyof typeof ReviewCheckStatus];

export const CaptionPlacement = {
  RESERVED_BOTTOM: 'reservedBottom',
  RESERVED_SIDE: 'reservedSide',
} as const;

export type CaptionPlacement = (typeof CaptionPlacement)[keyof typeof CaptionPlacement];

export const LearnerCheckpointState = {
  PENDING: 'pending',
  ATTEMPTED: 'attempted',
  INDEPENDENT: 'independent',
  ASSISTED: 'assisted',
} as const;

export type LearnerCheckpointState =
  (typeof LearnerCheckpointState)[keyof typeof LearnerCheckpointState];

export const LessonPhase = {
  WATCH: 'watch',
  PREDICT: 'predict',
  WORKED: 'worked',
  TRY: 'try',
  REFLECT: 'reflect',
} as const;

export type LessonPhase = (typeof LessonPhase)[keyof typeof LessonPhase];

export const LessonAudioMimeType = {
  AUDIO_WAV: 'audio/wav',
  AUDIO_MPEG: 'audio/mpeg',
} as const;

export type LessonAudioMimeType = (typeof LessonAudioMimeType)[keyof typeof LessonAudioMimeType];

export const LessonEvidenceKind = {
  FRAME: 'frame',
  CLIP: 'clip',
  AUDIO: 'audio',
  GEOMETRY: 'geometry',
  VALIDATION: 'validation',
} as const;

export type LessonEvidenceKind = (typeof LessonEvidenceKind)[keyof typeof LessonEvidenceKind];

export const SourceRefSchema = z.strictObject({
  passageId: z.string().min(1).max(100),
  startOffset: z.number().int().min(0).max(1000000),
  endOffset: z.number().int().min(0).max(1000000),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;

export const SourcePassageSchema = z.strictObject({
  passageId: z.string().min(1).max(100),
  materialId: z.string().min(1).max(100),
  publicationId: z.string().min(1).max(100),
  ownerSourceId: z.string().min(1).max(100),
  kind: z.enum(SourcePassageKind),
  correctsPassageIds: z.array(z.string().min(1).max(100)).min(0).max(24),
  pageId: z.union([z.string().min(1).max(100), z.null()]),
  sourceDigest: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  textDigest: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  text: z.string().min(1).max(20000),
});

export type SourcePassage = z.infer<typeof SourcePassageSchema>;

export const CodeBlockSchema = z.strictObject({
  codeBlockId: z.string().min(1).max(100),
  language: z.literal('python'),
  approvalReceiptId: z.string().min(1).max(100),
  variantOfCodeBlockId: z.union([z.string().min(1).max(100), z.null()]),
  lines: z
    .array(
      z.strictObject({
        lineId: z.string().min(1).max(100),
        text: z.string().max(200),
      }),
    )
    .min(1)
    .max(20),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
});

export type CodeBlock = z.infer<typeof CodeBlockSchema>;

export const StateValueSchema = z.union([
  z.number().int().min(-1000000).max(1000000),
  z.array(z.number().int().min(-1000000).max(1000000)).min(0).max(12),
]);

export type StateValue = z.infer<typeof StateValueSchema>;

export const StateBindingSchema = z.strictObject({
  name: z.string().min(1).max(100),
  value: StateValueSchema,
});

export type StateBinding = z.infer<typeof StateBindingSchema>;

export const TraceEventSchema = z.strictObject({
  eventId: z.string().min(1).max(100),
  lineId: z.string().min(1).max(100),
  operation: z.enum(TraceOperation),
  before: z.array(StateBindingSchema).min(0).max(8),
  after: z.array(StateBindingSchema).min(1).max(8),
  output: z.union([z.number().int().min(-1000000).max(1000000), z.null()]),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const TrustedTraceSchema = z.strictObject({
  traceId: z.string().min(1).max(100),
  codeBlockId: z.string().min(1).max(100),
  engineVersion: z.string().min(1).max(100),
  codeDigest: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  events: z.array(TraceEventSchema).min(1).max(64),
});

export type TrustedTrace = z.infer<typeof TrustedTraceSchema>;

export const AssetRegionSchema = z.strictObject({
  regionId: z.string().min(1).max(100),
  description: z.string().min(1).max(800),
  anchorX: z.number().min(0).max(1),
  anchorY: z.number().min(0).max(1),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
});

export type AssetRegion = z.infer<typeof AssetRegionSchema>;

export const AssetDescriptorSchema = z.strictObject({
  assetId: z.string().min(1).max(100),
  kind: z.enum(LessonAssetKind),
  digest: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  pixelWidth: z.number().int().min(1).max(10000),
  pixelHeight: z.number().int().min(1).max(10000),
  regions: z.array(AssetRegionSchema).min(0).max(8),
  sourceRefs: z.array(SourceRefSchema).min(0).max(8),
});

export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>;

export const TemplateDescriptorSchema = z.strictObject({
  templateId: z.enum(LessonTemplateKind),
  templateVersion: z.string().min(1).max(100),
  supportedLayoutVariants: z.array(z.string().min(1).max(100)).min(1).max(8),
  contentRules: z.array(z.string().min(1).max(600)).min(1).max(20),
});

export type TemplateDescriptor = z.infer<typeof TemplateDescriptorSchema>;

export const TeacherAnswerKeySchema = z.strictObject({
  answerKeyId: z.string().min(1).max(100),
  question: z.string().min(1).max(500),
  options: z
    .array(
      z.strictObject({
        optionId: z.string().min(1).max(100),
        text: z.string().min(1).max(200),
      }),
    )
    .min(2)
    .max(5),
  correctOptionId: z.string().min(1).max(100),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  approvalReceiptId: z.string().min(1).max(100),
});

export type TeacherAnswerKey = z.infer<typeof TeacherAnswerKeySchema>;

export const LessonInputSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  requestId: z.string().min(1).max(100),
  classId: z.string().min(1).max(100),
  courseRevisionId: z.string().min(1).max(100),
  conceptId: z.string().min(1).max(100),
  objective: z.string().min(1).max(800),
  audience: z.string().min(1).max(400),
  language: z.enum(LessonLanguage),
  targetDurationSeconds: z.number().int().min(30).max(300),
  sourcePacketHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  passages: z.array(SourcePassageSchema).min(1).max(24),
  codeBlocks: z.array(CodeBlockSchema).min(0).max(4),
  traces: z.array(TrustedTraceSchema).min(0).max(4),
  assets: z.array(AssetDescriptorSchema).min(0).max(12),
  templates: z.array(TemplateDescriptorSchema).min(1).max(3),
  teacherAnswerKeys: z.array(TeacherAnswerKeySchema).min(0).max(3),
  teacherInstructions: z.string().max(2000),
});

export type LessonInput = z.infer<typeof LessonInputSchema>;

export const NarrationBeatSchema = z.strictObject({
  beatId: z.string().min(1).max(100),
  text: z.string().min(1).max(1200),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  traceEventId: z.union([z.string().min(1).max(100), z.null()]),
  stateView: z.union([z.enum(TraceStateView), z.null()]),
});

export type NarrationBeat = z.infer<typeof NarrationBeatSchema>;

export const CodeTraceSceneSchema = z.strictObject({
  sceneId: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  templateVersion: z.string().min(1).max(100),
  layoutVariant: z.string().min(1).max(100),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  narration: z.array(NarrationBeatSchema).min(0).max(8),
  kind: z.literal('codeTrace'),
  params: z.strictObject({
    codeBlockId: z.string().min(1).max(100),
    traceId: z.string().min(1).max(100),
    traceEventIds: z.array(z.string().min(1).max(100)).min(1).max(64),
    focusVariable: z.string().min(1).max(100),
  }),
});

export type CodeTraceScene = z.infer<typeof CodeTraceSceneSchema>;

export const AnnotatedSourceSceneSchema = z.strictObject({
  sceneId: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  templateVersion: z.string().min(1).max(100),
  layoutVariant: z.string().min(1).max(100),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  narration: z.array(NarrationBeatSchema).min(0).max(8),
  kind: z.literal('annotatedSource'),
  params: z.strictObject({
    assetId: z.string().min(1).max(100),
    callouts: z
      .array(
        z.strictObject({
          calloutId: z.string().min(1).max(100),
          regionId: z.string().min(1).max(100),
          label: z.string().min(1).max(120),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          sourceRefs: z.array(SourceRefSchema).min(1).max(8),
        }),
      )
      .min(1)
      .max(5),
  }),
});

export type AnnotatedSourceScene = z.infer<typeof AnnotatedSourceSceneSchema>;

export const CheckpointSceneSchema = z.strictObject({
  sceneId: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  templateVersion: z.string().min(1).max(100),
  layoutVariant: z.string().min(1).max(100),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  narration: z.array(NarrationBeatSchema).min(0).max(8),
  kind: z.literal('checkpoint'),
  params: z.strictObject({
    checkpointId: z.string().min(1).max(100),
    traceId: z.union([z.string().min(1).max(100), z.null()]),
    holdEventId: z.union([z.string().min(1).max(100), z.null()]),
    holdStateView: z.literal('before'),
  }),
});

export type CheckpointScene = z.infer<typeof CheckpointSceneSchema>;

export const SceneSchema = z.union([
  CodeTraceSceneSchema,
  AnnotatedSourceSceneSchema,
  CheckpointSceneSchema,
]);

export type Scene = z.infer<typeof SceneSchema>;

export const HintSchema = z.strictObject({
  hintId: z.string().min(1).max(100),
  text: z.string().min(1).max(500),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
});

export type Hint = z.infer<typeof HintSchema>;

export const TraceAnswerRefSchema = z.strictObject({
  kind: z.literal('traceValue'),
  traceId: z.string().min(1).max(100),
  eventId: z.string().min(1).max(100),
  variable: z.string().min(1).max(100),
  stateView: z.literal('after'),
});

export type TraceAnswerRef = z.infer<typeof TraceAnswerRefSchema>;

export const SourceAnswerRefSchema = z.strictObject({
  kind: z.literal('teacherAnswer'),
  answerKeyId: z.string().min(1).max(100),
});

export type SourceAnswerRef = z.infer<typeof SourceAnswerRefSchema>;

export const CheckpointSchema = z.strictObject({
  checkpointId: z.string().min(1).max(100),
  sceneId: z.string().min(1).max(100),
  phase: z.enum(CheckpointPhase),
  kind: z.enum(CheckpointKind),
  question: z.string().min(1).max(500),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  options: z
    .array(
      z.strictObject({
        optionId: z.string().min(1).max(100),
        text: z.string().min(1).max(200),
      }),
    )
    .min(0)
    .max(5),
  answerRef: z.union([TraceAnswerRefSchema, SourceAnswerRefSchema]),
  hints: z.array(HintSchema).min(1).max(3),
  workedExplanation: z.array(NarrationBeatSchema).min(1).max(4),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const LessonPlanSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  title: z.string().min(1).max(120),
  objective: z.string().min(1).max(800),
  audience: z.string().min(1).max(400),
  language: z.enum(LessonLanguage),
  courseRevisionId: z.string().min(1).max(100),
  sourcePacketHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  scenes: z.array(SceneSchema).min(2).max(6),
  checkpoints: z.array(CheckpointSchema).min(1).max(3),
  reflectionPrompt: z.string().min(1).max(500),
  teacherQuestions: z.array(z.string().min(1).max(500)).min(0).max(8),
});

export type LessonPlan = z.infer<typeof LessonPlanSchema>;

export const AuthorResultSchema = z.union([
  z.strictObject({
    status: z.literal('ready'),
    plan: LessonPlanSchema,
  }),
  z.strictObject({
    status: z.literal('needsTeacherInput'),
    questions: z.array(z.string().min(1).max(500)).min(1).max(8),
    unsupportedRequirements: z.array(z.string().min(1).max(500)).min(0).max(8),
  }),
]);

export type AuthorResult = z.infer<typeof AuthorResultSchema>;

export const ReviewIssueSchema = z.strictObject({
  issueId: z.string().min(1).max(100),
  criterion: z.enum(ReviewCriterion),
  severity: z.enum(ReviewSeverity),
  sceneId: z.union([z.string().min(1).max(100), z.null()]),
  beatId: z.union([z.string().min(1).max(100), z.null()]),
  frameId: z.union([z.string().min(1).max(100), z.null()]),
  timeMs: z.union([z.number().int().min(0).max(300000), z.null()]),
  evidenceIds: z.array(z.string().min(1).max(100)).min(0).max(12),
  observed: z.string().min(1).max(600),
  expected: z.string().min(1).max(600),
  suggestedFix: z.string().min(1).max(600),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const ReviewResultSchema = z.strictObject({
  reviewedHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  verdict: z.enum(ReviewVerdict),
  checks: z
    .array(
      z.strictObject({
        criterion: z.enum(ReviewCriterion),
        status: z.enum(ReviewCheckStatus),
        evidenceIds: z.array(z.string().min(1).max(100)).min(0).max(12),
      }),
    )
    .min(1)
    .max(20),
  issues: z.array(ReviewIssueSchema).min(0).max(20),
  unassessed: z.array(z.string().min(1).max(500)).min(0).max(12),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const RepairResultSchema = z.union([
  z.strictObject({
    status: z.literal('repaired'),
    plan: LessonPlanSchema,
    addressedIssueIds: z.array(z.string().min(1).max(100)).min(1).max(20),
  }),
  z.strictObject({
    status: z.literal('needsTeacherInput'),
    questions: z.array(z.string().min(1).max(500)).min(1).max(8),
  }),
]);

export type RepairResult = z.infer<typeof RepairResultSchema>;

export const SceneAdjustmentSchema = z.strictObject({
  sceneId: z.string().min(1).max(100),
  layoutVariant: z.string().min(1).max(100),
  captionPlacement: z.enum(CaptionPlacement),
  beatAdjustments: z
    .array(
      z.strictObject({
        beatId: z.string().min(1).max(100),
        additionalHoldMs: z.number().int().min(0).max(3000),
        updateDelayMs: z.number().int().min(0).max(1000),
      }),
    )
    .min(0)
    .max(8),
});

export type SceneAdjustment = z.infer<typeof SceneAdjustmentSchema>;

export const RenderAdjustmentsSchema = z.strictObject({
  contentHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  baseRenderManifestHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  scenes: z.array(SceneAdjustmentSchema).min(1).max(6),
  addressedIssueIds: z.array(z.string().min(1).max(100)).min(1).max(20),
});

export type RenderAdjustments = z.infer<typeof RenderAdjustmentsSchema>;

export const VisualRepairResultSchema = z.union([
  z.strictObject({
    status: z.literal('repaired'),
    adjustments: RenderAdjustmentsSchema,
  }),
  z.strictObject({
    status: z.literal('needsTeacherInput'),
    questions: z.array(z.string().min(1).max(500)).min(1).max(8),
  }),
]);

export type VisualRepairResult = z.infer<typeof VisualRepairResultSchema>;

export const HelpResultSchema = z.union([
  z.strictObject({
    kind: z.literal('hintSelection'),
    hintId: z.string().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal('answer'),
    text: z.string().min(1).max(2500),
    sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  }),
  z.strictObject({
    kind: z.literal('insufficientContext'),
    text: z.string().min(1).max(800),
  }),
]);

export type HelpResult = z.infer<typeof HelpResultSchema>;

export const TemplateProposalSchema = z.strictObject({
  directions: z
    .array(
      z.strictObject({
        directionId: z.string().min(1).max(100),
        concept: z.string().min(1).max(600),
        teachingMechanism: z.string().min(1).max(800),
        composition: z.string().min(1).max(1000),
        motionSequence: z.array(z.string().min(1).max(500)).min(2).max(12),
        referenceAssetIds: z.array(z.string().min(1).max(100)).min(0).max(12),
        risks: z.array(z.string().min(1).max(500)).min(1).max(8),
      }),
    )
    .min(3)
    .max(3),
});

export type TemplateProposal = z.infer<typeof TemplateProposalSchema>;

export const LearnerCheckpointSchema = z.strictObject({
  checkpointId: z.string().min(1).max(100),
  question: z.string().min(1).max(500),
  kind: z.enum(CheckpointKind),
  options: z
    .array(
      z.strictObject({
        optionId: z.string().min(1).max(100),
        text: z.string().min(1).max(200),
      }),
    )
    .min(0)
    .max(5),
  state: z.enum(LearnerCheckpointState),
  availableHintCount: z.number().int().min(0).max(3),
});

export type LearnerCheckpoint = z.infer<typeof LearnerCheckpointSchema>;

export const VisibleTraceStateSchema = z.strictObject({
  eventId: z.string().min(1).max(100),
  lineId: z.string().min(1).max(100),
  operation: z.enum(TraceOperation),
  stateView: z.enum(TraceStateView),
  values: z.array(StateBindingSchema).min(0).max(8),
  output: z.union([z.number().int().min(-1000000).max(1000000), z.null()]),
});

export type VisibleTraceState = z.infer<typeof VisibleTraceStateSchema>;

export const PlaybackCueSchema = z.strictObject({
  cueId: z.string().min(1).max(100),
  beatId: z.string().min(1).max(100),
  artifactId: z.string().min(1).max(100),
  startFrame: z.number().int().min(0).max(9000),
  endFrame: z.number().int().min(1).max(9000),
  text: z.string().min(1).max(1200),
  traceEventId: z.union([z.string().min(1).max(100), z.null()]),
  stateView: z.union([z.enum(TraceStateView), z.null()]),
});

export type PlaybackCue = z.infer<typeof PlaybackCueSchema>;

export const FigureContextSchema = z.strictObject({
  assetId: z.string().min(1).max(100),
  callouts: z
    .array(
      z.strictObject({
        calloutId: z.string().min(1).max(100),
        label: z.string().min(1).max(120),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
    )
    .min(0)
    .max(5),
});

export type FigureContext = z.infer<typeof FigureContextSchema>;

export const LearnerPresentationSchema = z.union([
  z.strictObject({
    templateVersion: z.string().min(1).max(100),
    layoutVariant: z.string().min(1).max(100),
    kind: z.literal('codeTrace'),
    codeBlock: CodeBlockSchema,
    focusVariable: z.string().min(1).max(100),
  }),
  z.strictObject({
    templateVersion: z.string().min(1).max(100),
    layoutVariant: z.string().min(1).max(100),
    kind: z.literal('annotatedSource'),
    figure: FigureContextSchema,
  }),
  z.strictObject({
    templateVersion: z.string().min(1).max(100),
    layoutVariant: z.string().min(1).max(100),
    kind: z.literal('checkpoint'),
    codeBlock: z.union([CodeBlockSchema, z.null()]),
    focusVariable: z.union([z.string().min(1).max(100), z.null()]),
    figure: z.union([FigureContextSchema, z.null()]),
  }),
]);

export type LearnerPresentation = z.infer<typeof LearnerPresentationSchema>;

export const VisualCueSchema = z.strictObject({
  eventId: z.string().min(1).max(100),
  stateView: z.enum(TraceStateView),
  startFrame: z.number().int().min(0).max(9000),
  endFrame: z.number().int().min(1).max(9000),
});

export type VisualCue = z.infer<typeof VisualCueSchema>;

export const LearnerProjectionSchema = z.strictObject({
  releaseId: z.string().min(1).max(100),
  revisionId: z.string().min(1).max(100),
  contentHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  renderManifestHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  progressVersion: z.number().int().min(0).max(1000000),
  frame: z.number().int().min(0).max(9000),
  sceneId: z.string().min(1).max(100),
  sceneTitle: z.string().min(1).max(120),
  presentation: LearnerPresentationSchema,
  compositionBundleHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  fontBundleHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  sceneAdjustment: SceneAdjustmentSchema,
  visualCues: z.array(VisualCueSchema).min(0).max(128),
  phase: z.enum(LessonPhase),
  visibleTraceStates: z.array(VisibleTraceStateSchema).min(0).max(128),
  narrationCues: z.array(PlaybackCueSchema).min(0).max(24),
  videoArtifactId: z.string().min(1).max(100).optional(),
  allowedArtifactIds: z.array(z.string().min(1).max(100)).min(0).max(24),
  checkpoint: z.union([LearnerCheckpointSchema, z.null()]),
});

export type LearnerProjection = z.infer<typeof LearnerProjectionSchema>;

export const CheckpointAttemptSchema = z.strictObject({
  commandId: z.uuid(),
  expectedProgressVersion: z.number().int().min(0).max(1000000),
  checkpointId: z.string().min(1).max(100),
  answer: z.union([
    z.strictObject({
      kind: z.literal('number'),
      value: z.number().int().min(-1000000).max(1000000),
    }),
    z.strictObject({
      kind: z.literal('option'),
      optionId: z.string().min(1).max(100),
    }),
  ]),
});

export type CheckpointAttempt = z.infer<typeof CheckpointAttemptSchema>;

export const NoteAnchorSchema = z.strictObject({
  releaseId: z.string().min(1).max(100),
  sceneId: z.string().min(1).max(100),
  phase: z.enum(LessonPhase),
  frame: z.number().int().min(0).max(9000),
  traceEventId: z.union([z.string().min(1).max(100), z.null()]),
  sourceRef: z.union([SourceRefSchema, z.null()]),
});

export type NoteAnchor = z.infer<typeof NoteAnchorSchema>;

export const PrivateNoteSchema = z.strictObject({
  noteId: z.string().min(1).max(100),
  expectedVersion: z.number().int().min(0).max(1000000),
  anchor: NoteAnchorSchema,
  text: z.string().max(2000),
  isBookmark: z.boolean(),
});

export type PrivateNote = z.infer<typeof PrivateNoteSchema>;

export const SpeechArtifactSchema = z.strictObject({
  artifactId: z.string().min(1).max(100),
  beatId: z.string().min(1).max(100),
  contentHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  textHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  audioDigest: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  durationMs: z.number().int().min(1).max(300000),
  byteLength: z.number().int().min(1).max(16777216),
  mimeType: z.enum(LessonAudioMimeType),
  sampleRateHz: z.number().int().min(8000).max(96000),
  voiceConfigHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
});

export type SpeechArtifact = z.infer<typeof SpeechArtifactSchema>;

export const TimelineCueSchema = z.strictObject({
  cueId: z.string().min(1).max(100),
  sceneId: z.string().min(1).max(100),
  phase: z.enum(LessonPhase),
  beatId: z.string().min(1).max(100),
  audioArtifactId: z.string().min(1).max(100),
  startFrame: z.number().int().min(0).max(9000),
  endFrame: z.number().int().min(1).max(9000),
  traceEventId: z.union([z.string().min(1).max(100), z.null()]),
  stateView: z.union([z.enum(TraceStateView), z.null()]),
});

export type TimelineCue = z.infer<typeof TimelineCueSchema>;

export const EvidenceItemSchema = z.strictObject({
  evidenceId: z.string().min(1).max(100),
  artifactId: z.string().min(1).max(100),
  kind: z.enum(LessonEvidenceKind),
  digest: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  sceneId: z.union([z.string().min(1).max(100), z.null()]),
  frame: z.union([z.number().int().min(0).max(9000), z.null()]),
  phase: z.union([z.enum(LessonPhase), z.null()]),
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const RenderManifestSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  revisionId: z.string().min(1).max(100),
  contentHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  inputPacketHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  adjustmentsHash: z.union([z.string().regex(new RegExp('^[a-f0-9]{64}$')), z.null()]),
  rendererVersion: z.string().min(1).max(100),
  compositionBundleHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  fontBundleHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  templateVersions: z
    .array(
      z.strictObject({
        templateId: z.string().min(1).max(100),
        version: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(3),
  width: z.literal(1920),
  height: z.literal(1080),
  fps: z.literal(30),
  speechArtifacts: z.array(SpeechArtifactSchema).min(1).max(24),
  cues: z.array(TimelineCueSchema).min(1).max(48),
  evidence: z.array(EvidenceItemSchema).min(1).max(100),
  sourceAssetDigests: z
    .array(
      z.strictObject({
        assetId: z.string().min(1).max(100),
        digest: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
      }),
    )
    .min(0)
    .max(12),
});

export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export const ApprovalCommandSchema = z.strictObject({
  commandId: z.uuid(),
  expectedLessonVersion: z.number().int().min(0).max(1000000),
  revisionId: z.string().min(1).max(100),
  contentHash: z.string().regex(new RegExp('^[a-f0-9]{64}$')),
  renderManifestHash: z.union([z.string().regex(new RegExp('^[a-f0-9]{64}$')), z.null()]),
  acknowledgedEvidenceIds: z.array(z.string().min(1).max(100)).min(1).max(100),
});

export type ApprovalCommand = z.infer<typeof ApprovalCommandSchema>;

/** Durable job states are public so both desktop and HTTP consumers show the same progress. */
export const LessonStatus = {
  ADMITTED: 'admitted',
  DRAFTING: 'drafting',
  REVIEWING_CONTENT: 'reviewingContent',
  REPAIRING_CONTENT: 'repairingContent',
  RECHECKING_CONTENT: 'recheckingContent',
  AWAITING_SCRIPT_APPROVAL: 'awaitingScriptApproval',
  SYNTHESIZING: 'synthesizing',
  RENDERING: 'rendering',
  REVIEWING_VISUALS: 'reviewingVisuals',
  REPAIRING_VISUALS: 'repairingVisuals',
  RECHECKING_VISUALS: 'recheckingVisuals',
  PREVIEW_READY: 'previewReady',
  RELEASED: 'released',
  NEEDS_TEACHER_INPUT: 'needsTeacherInput',
  BUDGET_BLOCKED: 'budgetBlocked',
  USAGE_UNCERTAIN: 'usageUncertain',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type LessonStatus = (typeof LessonStatus)[keyof typeof LessonStatus];

export const LessonStatusSchema = z.enum(LessonStatus);

export const GuidedLessonFailure = {
  INVALID_REQUEST: 'invalidRequest',
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'notFound',
  CONFLICT: 'conflict',
  UNAVAILABLE: 'unavailable',
  INVALID_STATE: 'invalidState',
  BUDGET_EXCEEDED: 'budgetExceeded',
  CONTENT_REJECTED: 'contentRejected',
  INTERNAL: 'internal',
} as const;

export type GuidedLessonFailure = (typeof GuidedLessonFailure)[keyof typeof GuidedLessonFailure];

const LessonIdSchema = z.string().min(1).max(100);
const LessonDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const LessonVersionSchema = z.number().int().min(0).max(1000000);
const LessonTimestampSchema = z.iso.datetime();

export const LessonUsageSchema = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  generationAttempts: z.number().int().min(0),
  speechCharacters: z.number().int().min(0),
  speechSeconds: z.number().min(0),
  artifactBytes: z.number().int().min(0),
});

export type LessonUsage = z.infer<typeof LessonUsageSchema>;

export const GuidedLessonSummarySchema = z.strictObject({
  id: LessonIdSchema,
  classId: LessonIdSchema,
  title: z.string().min(1).max(200),
  status: LessonStatusSchema,
  version: LessonVersionSchema,
  language: z.enum(LessonLanguage),
  updatedAt: LessonTimestampSchema,
  releaseId: LessonIdSchema.nullable(),
  error: z.string().max(2000).nullable(),
});

export type GuidedLessonSummary = z.infer<typeof GuidedLessonSummarySchema>;

export const GuidedLessonDetailSchema = GuidedLessonSummarySchema.extend({
  input: LessonInputSchema.nullable(),
  plan: LessonPlanSchema.nullable(),
  contentHash: LessonDigestSchema.nullable(),
  review: ReviewResultSchema.nullable(),
  visualReview: ReviewResultSchema.nullable(),
  manifest: RenderManifestSchema.nullable(),
  scriptApproved: z.boolean(),
  previewApproved: z.boolean(),
  usage: LessonUsageSchema,
});

export type GuidedLessonDetail = z.infer<typeof GuidedLessonDetailSchema>;

export const TeacherInputSchema = z.strictObject({
  classId: LessonIdSchema,
  revisions: z
    .array(
      z.strictObject({
        id: LessonIdSchema,
        title: z.string().max(300),
        sections: z
          .array(
            z.strictObject({
              id: LessonIdSchema,
              title: z.string().max(300),
              passageIds: z.array(LessonIdSchema).max(100),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
  passages: z.array(SourcePassageSchema).max(200),
});

export type TeacherInput = z.infer<typeof TeacherInputSchema>;

export const StudentRequestResolution = {
  REUSE: 'reuse',
  TEXT: 'text',
  LIVE: 'live',
  DRAFT: 'draft',
} as const;

export type StudentRequestResolution =
  (typeof StudentRequestResolution)[keyof typeof StudentRequestResolution];

export const StudentRequestStatus = { OPEN: 'open', RESOLVED: 'resolved' } as const;

export type StudentRequestStatus = (typeof StudentRequestStatus)[keyof typeof StudentRequestStatus];

export const StudentLessonRequestSchema = z.strictObject({
  id: LessonIdSchema,
  classId: LessonIdSchema,
  studentId: LessonIdSchema,
  lessonId: LessonIdSchema.nullable(),
  releaseId: LessonIdSchema.nullable(),
  sceneId: LessonIdSchema.nullable(),
  text: z.string().min(1).max(2000),
  status: z.enum(StudentRequestStatus),
  resolution: z.enum(StudentRequestResolution).nullable(),
  reply: z.string().max(4000).nullable(),
  createdAt: LessonTimestampSchema,
  updatedAt: LessonTimestampSchema,
});

export type StudentLessonRequest = z.infer<typeof StudentLessonRequestSchema>;

export const GuidedLessonReadAction = {
  LIST: 'list',
  DETAIL: 'detail',
  STATUS: 'status',
  TEACHER_INPUT: 'teacherInput',
  PROJECTION: 'projection',
  PREVIEW: 'preview',
  NOTES: 'notes',
  REQUESTS: 'requests',
} as const;

export const GuidedLessonReadRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal(GuidedLessonReadAction.LIST),
    classId: LessonIdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonReadAction.DETAIL),
    classId: LessonIdSchema,
    lessonId: LessonIdSchema,
  }),
  z.strictObject({
    action: z.literal(GuidedLessonReadAction.STATUS),
    classId: LessonIdSchema,
    lessonId: LessonIdSchema,
  }),
  z.strictObject({
    action: z.literal(GuidedLessonReadAction.TEACHER_INPUT),
    classId: LessonIdSchema,
    courseRevisionId: LessonIdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonReadAction.PROJECTION),
    classId: LessonIdSchema,
    releaseId: LessonIdSchema,
    sceneId: LessonIdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonReadAction.PREVIEW),
    classId: LessonIdSchema,
    lessonId: LessonIdSchema,
    sceneId: LessonIdSchema.optional(),
    phase: z.enum(LessonPhase).optional(),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonReadAction.NOTES),
    classId: LessonIdSchema,
    releaseId: LessonIdSchema,
  }),
  z.strictObject({ action: z.literal(GuidedLessonReadAction.REQUESTS), classId: LessonIdSchema }),
]);

export const GuidedLessonReadSchema = GuidedLessonReadRequestSchema;

export type GuidedLessonReadRequest = z.infer<typeof GuidedLessonReadRequestSchema>;

export const LessonHelpRole = { USER: 'user', ASSISTANT: 'assistant' } as const;

export type LessonHelpRole = (typeof LessonHelpRole)[keyof typeof LessonHelpRole];

export const LessonHelpMessageSchema = z.strictObject({
  role: z.enum(LessonHelpRole),
  text: z.string().min(1).max(2500),
});

export type LessonHelpMessage = z.infer<typeof LessonHelpMessageSchema>;

export const GuidedLessonAction = {
  CREATE: 'create',
  START: 'start',
  SAVE_PLAN: 'savePlan',
  APPROVE_SCRIPT: 'approveScript',
  RENDER: 'render',
  APPROVE_PREVIEW: 'approvePreview',
  RELEASE: 'release',
  WITHDRAW: 'withdraw',
  CANCEL: 'cancel',
  RETRY: 'retry',
  PROGRESS: 'progress',
  ATTEMPT: 'attempt',
  HINT: 'hint',
  HELP: 'help',
  SAVE_NOTE: 'saveNote',
  DELETE_NOTE: 'deleteNote',
  REQUEST: 'request',
  RESOLVE_REQUEST: 'resolveRequest',
} as const;

export const LearnerProgressIntent = {
  WATCH_COMPLETE: 'watchComplete',
  NEXT: 'next',
  REVISIT: 'revisit',
  RETRY: 'retry',
  WORKED_ANSWER: 'workedAnswer',
  REFLECT: 'reflect',
} as const;

export type LearnerProgressIntent =
  (typeof LearnerProgressIntent)[keyof typeof LearnerProgressIntent];

export const TeacherCodeApprovalSchema = z.strictObject({
  code: z.string().min(1).max(4000),
  sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  variantOfCodeBlockId: LessonIdSchema.nullable(),
});

export type TeacherCodeApproval = z.infer<typeof TeacherCodeApprovalSchema>;
const TeacherCommandFields = {
  commandId: z.uuid(),
  classId: LessonIdSchema,
  lessonId: LessonIdSchema,
  expectedVersion: LessonVersionSchema,
};
const LearnerCommandFields = {
  commandId: z.uuid(),
  classId: LessonIdSchema,
  lessonId: LessonIdSchema,
  releaseId: LessonIdSchema,
  expectedProgressVersion: LessonVersionSchema,
};
export const GuidedLessonCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal(GuidedLessonAction.CREATE),
    commandId: z.uuid(),
    classId: LessonIdSchema,
    courseRevisionId: LessonIdSchema,
    conceptId: LessonIdSchema,
    objective: z.string().min(1).max(500),
    audience: z.string().min(1).max(400),
    language: z.enum(LessonLanguage),
    targetDurationSeconds: z.number().int().min(30).max(300),
    passageIds: z.array(LessonIdSchema).min(1).max(24),
    teacherInstructions: z.string().max(2000),
    codeApproval: TeacherCodeApprovalSchema.nullable(),
    practiceCodeApproval: TeacherCodeApprovalSchema.nullable(),
  }),
  z.strictObject({ action: z.literal(GuidedLessonAction.START), ...TeacherCommandFields }),
  z.strictObject({ action: z.literal(GuidedLessonAction.RENDER), ...TeacherCommandFields }),
  z.strictObject({ action: z.literal(GuidedLessonAction.CANCEL), ...TeacherCommandFields }),
  z.strictObject({ action: z.literal(GuidedLessonAction.RETRY), ...TeacherCommandFields }),
  z.strictObject({ action: z.literal(GuidedLessonAction.WITHDRAW), ...TeacherCommandFields }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.SAVE_PLAN),
    ...TeacherCommandFields,
    plan: LessonPlanSchema,
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.APPROVE_SCRIPT),
    ...TeacherCommandFields,
    contentHash: LessonDigestSchema,
    acknowledgedSceneIds: z.array(LessonIdSchema).min(1).max(12),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.APPROVE_PREVIEW),
    ...TeacherCommandFields,
    renderManifestHash: LessonDigestSchema,
    acknowledgedEvidenceIds: z.array(LessonIdSchema).min(1).max(100),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.RELEASE),
    ...TeacherCommandFields,
    contentHash: LessonDigestSchema,
    renderManifestHash: LessonDigestSchema,
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.PROGRESS),
    ...LearnerCommandFields,
    sceneId: LessonIdSchema,
    intent: z.enum(LearnerProgressIntent),
    frame: z.number().int().min(0).max(9000),
    reflection: z.string().max(4000),
    noteId: LessonIdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.ATTEMPT),
    ...LearnerCommandFields,
    checkpointId: LessonIdSchema,
    answer: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('number'),
        value: z.number().int().min(-1000000).max(1000000),
      }),
      z.strictObject({ kind: z.literal('option'), optionId: LessonIdSchema }),
    ]),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.HINT),
    ...LearnerCommandFields,
    checkpointId: LessonIdSchema,
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.HELP),
    ...LearnerCommandFields,
    sceneId: LessonIdSchema,
    message: z.string().min(1).max(2000),
    history: z.array(LessonHelpMessageSchema).max(12).optional(),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.SAVE_NOTE),
    ...LearnerCommandFields,
    note: PrivateNoteSchema,
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.DELETE_NOTE),
    ...LearnerCommandFields,
    noteId: LessonIdSchema,
    expectedNoteVersion: LessonVersionSchema,
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.REQUEST),
    commandId: z.uuid(),
    classId: LessonIdSchema,
    lessonId: LessonIdSchema.nullable(),
    releaseId: LessonIdSchema.nullable(),
    sceneId: LessonIdSchema.nullable(),
    text: z.string().min(1).max(2000),
  }),
  z.strictObject({
    action: z.literal(GuidedLessonAction.RESOLVE_REQUEST),
    commandId: z.uuid(),
    classId: LessonIdSchema,
    requestId: LessonIdSchema,
    resolution: z.enum(StudentRequestResolution),
    lessonId: LessonIdSchema.nullable(),
    text: z.string().max(4000),
  }),
]);

export type GuidedLessonCommand = z.infer<typeof GuidedLessonCommandSchema>;

export const GuidedLessonViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('list'),
    classes: z.array(ClassSchema),
    lessons: z.array(GuidedLessonSummarySchema),
  }),
  z.strictObject({ kind: z.literal('detail'), lesson: GuidedLessonDetailSchema }),
  z.strictObject({ kind: z.literal('status'), lesson: GuidedLessonSummarySchema }),
  TeacherInputSchema.extend({ kind: z.literal('teacherInput') }),
  z.strictObject({
    kind: z.literal('projection'),
    projection: LearnerProjectionSchema,
    notes: z.array(PrivateNoteSchema),
    reflectionPrompt: z.string().max(2000),
  }),
  z.strictObject({ kind: z.literal('notes'), notes: z.array(PrivateNoteSchema) }),
  z.strictObject({ kind: z.literal('requests'), requests: z.array(StudentLessonRequestSchema) }),
  z.strictObject({ kind: z.literal('help'), result: HelpResultSchema }),
  z.strictObject({
    kind: z.literal('hint'),
    hintId: LessonIdSchema,
    text: z.string().min(1).max(500),
    sourceRefs: z.array(SourceRefSchema).min(1).max(8),
  }),
]);

export type GuidedLessonView = z.infer<typeof GuidedLessonViewSchema>;

export const GuidedLessonFailedSchema = z.strictObject({
  kind: z.literal('failed'),
  code: z.enum(GuidedLessonFailure),
  message: z.string().min(1).max(2000),
});

export const GuidedLessonReplySchema = z.union([GuidedLessonViewSchema, GuidedLessonFailedSchema]);

export type GuidedLessonReply = z.infer<typeof GuidedLessonReplySchema>;

export const GuidedLessonArtifactRequestSchema = z.strictObject({
  classId: LessonIdSchema,
  lessonId: LessonIdSchema,
  releaseId: LessonIdSchema.nullable(),
  artifactId: LessonIdSchema,
});

export type GuidedLessonArtifactRequest = z.infer<typeof GuidedLessonArtifactRequestSchema>;

export const GuidedLessonArtifactReplySchema = z.union([
  z.strictObject({
    kind: z.literal('artifact'),
    artifactId: LessonIdSchema,
    mimeType: z.enum([
      'audio/wav',
      'audio/mpeg',
      'image/png',
      'image/jpeg',
      'application/json',
      'video/mp4',
    ]),
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength <= 16 * 1024 * 1024, 'Artifact exceeds size limit'),
    digest: LessonDigestSchema,
  }),
  GuidedLessonFailedSchema,
]);

export type GuidedLessonArtifactReply = z.infer<typeof GuidedLessonArtifactReplySchema>;

export const GuidedLessonArtifactResponseSchema = GuidedLessonArtifactReplySchema;

export type GuidedLessonArtifactResponse = GuidedLessonArtifactReply;
