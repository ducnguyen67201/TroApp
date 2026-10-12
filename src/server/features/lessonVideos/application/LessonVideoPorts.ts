import type {
  LessonContent,
  LessonVideo,
  LessonArtifactKind,
  LessonVideoCommand,
} from '#contracts/LessonVideos.js';
import type { LessonRenderRequest } from '#contracts/LessonRenderProtocol.js';
import type { LessonVideoSettings } from '../../../config/LessonVideoConfig.js';

export interface LessonSource {
  id: string;
  name: string;
  text: string;
}

export interface LessonUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requestId: string | null;
}

export interface StoredLesson extends LessonVideo {
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
  ): Promise<{ content: LessonContent; usage: LessonUsage }>;
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
  }): void;
}
