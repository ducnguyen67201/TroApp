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
      sources: MaterialSource[];
    };

export interface MaterialGeneration {
  readonly available: boolean;
  readonly version: string;
  countInput(input: MaterialStageInput, signal: AbortSignal): Promise<number>;
  generate(
    input: MaterialStageInput,
    signal: AbortSignal,
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
  deadlineMs: number;
}

export const defaultMaterialGenerationPolicy: MaterialGenerationPolicy = {
  calls: 24,
  inputTokens: 150_000,
  outputTokens: 48_000,
  stageInputTokens: 64_000,
  stageOutputTokens: 2000,
  deadlineMs: 540_000,
};
