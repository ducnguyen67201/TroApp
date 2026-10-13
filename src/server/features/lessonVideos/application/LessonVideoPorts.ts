import type {
  LessonContent,
  LessonVideo,
  LessonArtifactKind,
  LessonVideoCommand,
  LessonScreen,
} from '#contracts/LessonVideos.js';
import { LessonModelAttemptState } from '#contracts/LessonVisuals.js';
import type {
  LessonModelUsage,
  LessonModelAttempt,
  StoredLessonVisual,
  LessonVisualBrief,
} from '#contracts/LessonVisuals.js';
import type { LessonRenderRequest } from '#contracts/LessonRenderProtocol.js';
import type { LessonVideoSettings } from '../../../config/LessonVideoConfig.js';

export interface LessonSource {
  id: string;
  name: string;
  text: string;
}

export type LessonUsage = LessonModelUsage;

export interface StoredLesson extends LessonVideo {
  stateVersion: number;
  visuals: StoredLessonVisual[];
  modelAttempts: LessonModelAttempt[];
  ownerId: string;
  requestId: string;
  requestHash: string;
  recordVersion: number;
  sources: LessonSource[];
  settings: LessonVideoSettings;
  rendererBuild: string;
  contentStarted: boolean;
  contentUsage: LessonUsage | null;
  speechCharacters: number;
  combineAttempts: number;
  renderRecoveries: number;
  deadline: string;
  claimId: string | null;
}

export interface LessonArtifact {
  id: string;
  lessonId: string;
  kind: (typeof LessonArtifactKind)[keyof typeof LessonArtifactKind];
  bytes: Uint8Array;
}

export interface LessonVideoStore {
  findRequest(ownerId: string, requestId: string): Promise<StoredLesson | null>;
  list(ownerId: string): Promise<StoredLesson[]>;
  read(id: string): Promise<StoredLesson | null>;
  createLessonWithReservation(lesson: StoredLesson): Promise<StoredLesson>;
  saveStageResult(lesson: StoredLesson, artifact?: LessonArtifact): Promise<StoredLesson>;
  beginModelAttempt(lesson: StoredLesson, attempt: LessonModelAttempt): Promise<StoredLesson>;
  saveModelAttemptResult(
    lesson: StoredLesson,
    attemptId: string,
    result: Pick<LessonModelAttempt, 'state' | 'usage' | 'usageUncertain'>,
    artifact?: LessonArtifact,
  ): Promise<StoredLesson>;
  claimNextLesson(now: Date, claimId: string): Promise<StoredLesson | null>;
  renewClaim(id: string, claimId: string, leaseUntil: Date): Promise<boolean>;
  readArtifact(lessonId: string, artifactId: string): Promise<LessonArtifact | null>;
  deleteLesson(lesson: StoredLesson): Promise<void>;
  close(): Promise<void>;
}

export interface LessonSources {
  list(
    ownerId: string,
  ): Promise<{ id: string; name: string; materials: { id: string; name: string }[] }[]>;
  read(ownerId: string, classId: string, materialIds: string[]): Promise<LessonSource[]>;
  authorize(ownerId: string, classId: string): Promise<void>;
}

export interface LessonContentProvider {
  readonly available: boolean;
  count(lesson: Pick<StoredLesson, 'prompt' | 'sources' | 'locale' | 'settings'>): Promise<number>;
  generate(
    lesson: StoredLesson,
    signal: AbortSignal,
  ): Promise<{ content: LessonContent; usage: LessonUsage; briefs?: LessonVisualBrief[] }>;
}

/** Each call is one charged dispatch; retry decisions belong to the saved job. */
export class LessonModelRequestError extends Error {
  constructor(
    readonly outcome:
      typeof LessonModelAttemptState.INCOMPLETE | typeof LessonModelAttemptState.UNAVAILABLE,
    readonly usage: LessonUsage | null,
    readonly usageUncertain: boolean,
  ) {
    super('Lesson model request did not complete.');
  }
}

export interface LessonVisualRequest {
  screen: LessonScreen;
  brief: LessonVisualBrief;
  durationSeconds: number;
  locale: 'en' | 'vi';
  settings: LessonVideoSettings;
  source?: string;
  diagnostic?: string;
}

export const LessonVisualResultKind = {
  SOURCE: 'source',
  INCOMPLETE: 'incomplete',
  UNAVAILABLE: 'unavailable',
} as const;

export type LessonVisualResult =
  | { kind: typeof LessonVisualResultKind.SOURCE; source: string; usage: LessonUsage }
  | { kind: typeof LessonVisualResultKind.INCOMPLETE; source?: string; usage: LessonUsage | null }
  | { kind: typeof LessonVisualResultKind.UNAVAILABLE; usage: null; usageUncertain: true };

export interface LessonVisualProvider {
  countRequest(request: LessonVisualRequest): Promise<number>;
  generateVisual(request: LessonVisualRequest, signal: AbortSignal): Promise<LessonVisualResult>;
}

/** Only validated, bounded worker diagnostics cross this application boundary. */
export class LessonRenderCodeError extends Error {
  constructor(readonly diagnostic: string) {
    super('Lesson animation could not execute.');
  }
}

export interface LessonSpeechProvider {
  synthesize(
    text: string,
    settings: LessonVideoSettings,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; durationSeconds: number }>;
}

export interface LessonRenderer {
  readBuildId(): Promise<string>;
  readVisualRuntime?(): Promise<string | null>;
  render(
    request: LessonRenderRequest,
    timeoutMs: number,
    signal: AbortSignal,
    attempts: number,
  ): Promise<Uint8Array>;
}

export type CreateLessonCommand = Extract<LessonVideoCommand, { kind: 'create' | 'regenerate' }>;

export interface LessonDiagnostics {
  (event: {
    lessonId: string;
    revision: number;
    stage: LessonVideo['stage'];
    state: string;
    elapsedMs?: number;
    requestId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    screenId?: string;
    attempt?: number;
    reason?: string;
    sourceDigest?: string;
  }): void;
}
