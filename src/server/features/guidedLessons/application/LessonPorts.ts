import type {
  LessonInput,
  LessonPlan,
  ReviewResult,
  RenderManifest,
  RenderAdjustments,
  SpeechArtifact,
  LearnerProjection,
  SourcePassage,
  LessonLanguage,
  LessonPhase,
} from '#contracts/GuidedLessons.js';

export const LessonModelStage = {
  DRAFT: 'draft',
  REVIEW: 'review',
  REPAIR: 'repair',
  VISUAL_REVIEW: 'visualReview',
  VISUAL_REPAIR: 'visualRepair',
  HELP: 'help',
} as const;

export type LessonModelStage = (typeof LessonModelStage)[keyof typeof LessonModelStage];

/** Only throw this when no provider generation request could have been submitted. */
export class LessonProviderNotDispatchedError extends Error {
  constructor(message = 'The lesson provider is unavailable.') {
    super(message);
    this.name = 'LessonProviderNotDispatchedError';
  }
}

export const LessonArtifactKind = {
  FRAME: 'frame',
  CLIP: 'clip',
  AUDIO: 'audio',
  SOURCE: 'source',
} as const;

export type LessonArtifactKind = (typeof LessonArtifactKind)[keyof typeof LessonArtifactKind];

export interface LessonMediaArtifact {
  artifactId: string;
  kind: LessonArtifactKind;
  mimeType: string;
  bytes: Uint8Array;
  digest: string;
  sceneId: string | null;
  phase: LessonPhase | null;
}

export interface LessonModelRequest {
  stage: LessonModelStage;
  input: LessonInput;
  plan: LessonPlan | null;
  review: ReviewResult | null;
  manifest: RenderManifest | null;
  evidence: LessonMediaArtifact[];
  contentHash: string;
  maxOutputTokens: number;
  helpContext?: {
    question: string;
    visibleProjection: LearnerProjection;
    sourcePassages: SourcePassage[];
    history: { role: 'user' | 'assistant'; text: string }[];
  };
}

/** Provider work is outside database transactions; every dispatch has a prior durable reservation. */
export interface LessonModel {
  countInput(request: LessonModelRequest, signal?: AbortSignal): Promise<number>;
  generate(
    request: LessonModelRequest,
    signal: AbortSignal,
  ): Promise<{ result: unknown; usage: { inputTokens: number; outputTokens: number } | null }>;
}

export interface LessonSpeech {
  synthesize(
    request: { beatId: string; text: string; language: LessonLanguage; contentHash: string },
    signal: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    mimeType: 'audio/wav' | 'audio/mpeg';
    durationMs: number;
    sampleRate: number;
    voiceConfigHash: string;
  }>;
}

/** Reserves and settles every coding-agent request independently of render completion. */
export interface LessonRenderLifecycle {
  beforeModelCall(attemptId: string): Promise<void>;
  afterModelCall(
    attemptId: string,
    usage: { inputTokens: number; outputTokens: number } | null,
  ): Promise<void>;
}

export interface LessonRenderer {
  /** Validate execution prerequisites before the first paid content request. */
  checkReady?(signal: AbortSignal): Promise<void>;
  render(
    request: {
      revisionId: string;
      input: LessonInput;
      plan: LessonPlan;
      contentHash: string;
      speechArtifacts: { descriptor: SpeechArtifact; bytes: Uint8Array }[];
      adjustments: RenderAdjustments | null;
    },
    signal: AbortSignal,
    lifecycle?: LessonRenderLifecycle,
  ): Promise<{ manifest: RenderManifest; artifacts: LessonMediaArtifact[] }>;
}
