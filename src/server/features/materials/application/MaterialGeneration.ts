import type {
  MaterialPreparationDiagnostic,
  MaterialProviderOperation,
  MaterialReferenceIssue,
} from './MaterialPreparationError.js';
import type { MaterialFile } from './MaterialPreparation.js';
import type {
  MaterialGenerationOutput,
  DocumentBriefContent,
  MaterialSourcePassage,
} from '#contracts/MaterialContext.js';
import type { MaterialSource } from '#contracts/ClassroomMaterials.js';

export const MaterialGenerationStage = { BRIEF: 'brief', COMPOSITION: 'composition' } as const;

export type MaterialStageInput =
  | {
      kind: typeof MaterialGenerationStage.BRIEF;
      materialId: string;
      locale: 'en' | 'vi';
      passages: MaterialSourcePassage[];
      summaries: DocumentBriefContent[];
      file: MaterialFile | null;
    }
  | {
      kind: typeof MaterialGenerationStage.COMPOSITION;
      locale: 'en' | 'vi';
      teacherInstructions: string;
      revision?: {
        request: string;
        previousSummary: string;
        previousSections: {
          title: string;
          instruction: string;
          practiceCheckpoints?: import('#contracts/PracticeCheck.js').PracticeCheckpoint[];
        }[];
        teacherNotes: { materialId: string; location: string; text: string }[];
      };
      documents: { materialId: string; brief: DocumentBriefContent; teacherNote: string | null }[];
      sourceUnits: { id: string; materialId: string; location: string }[];
      sourceMap: { passageId: string; pageId: string; materialId: string }[];
      citationRepair?: {
        previousComposition: Extract<
          MaterialGenerationOutput,
          { kind: 'composition' }
        >['composition'];
        issues: MaterialReferenceIssue[];
        issueCount: number;
        evidence: MaterialSourcePassage[];
      };
      sources: MaterialSource[];
    };

/** Internal correlation only; never includes source text, filenames or credentials. */
export interface MaterialGenerationContext {
  classId: string;
  jobId: string;
  collectionVersion: number;
  stageKey: string;
}

export const MaterialProviderRequestState = {
  STARTED: 'started',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export interface MaterialProviderRequestEvent
  extends Partial<MaterialGenerationContext>, Partial<MaterialPreparationDiagnostic> {
  localRequestId: string;
  state: (typeof MaterialProviderRequestState)[keyof typeof MaterialProviderRequestState];
  operation: MaterialProviderOperation;
  generationStage: MaterialStageInput['kind'];
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens?: number;
  durationMs: number;
  materialId?: string;
  fileBytes: number;
  passageCount: number;
  summaryCount: number;
  documentCount: number;
  sourceUnitCount: number;
  citationRepair?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface MaterialGeneration {
  readonly available: boolean;
  readonly version: string;
  countInput(
    input: MaterialStageInput,
    signal: AbortSignal,
    context?: MaterialGenerationContext,
  ): Promise<number>;
  generate(
    input: MaterialStageInput,
    signal: AbortSignal,
    context?: MaterialGenerationContext,
  ): Promise<{
    output: MaterialGenerationOutput;
    usedInput: number | null;
    usedOutput: number | null;
  }>;
}

export interface MaterialGenerationPolicy {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  stageInputTokens: number;
  stageOutputTokens: number;
  compositionOutputTokens: number;
  compositionTimeoutMs: number;
  deadlineMs: number;
}

export const defaultMaterialGenerationPolicy: MaterialGenerationPolicy = {
  calls: 24,
  inputTokens: 150_000,
  outputTokens: 160_000,
  stageInputTokens: 100_000,
  stageOutputTokens: 2000,
  compositionOutputTokens: 60_000,
  compositionTimeoutMs: 240_000,
  deadlineMs: 540_000,
};

/** Briefs stay compact; lesson JSON and model reasoning have a separate composition allowance. */
export function readMaterialStageOutputTokens(
  policy: Pick<MaterialGenerationPolicy, 'stageOutputTokens' | 'compositionOutputTokens'>,
  stage: MaterialStageInput['kind'],
): number {
  return stage === MaterialGenerationStage.COMPOSITION
    ? policy.compositionOutputTokens
    : policy.stageOutputTokens;
}
