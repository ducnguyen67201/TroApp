import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type {
  PracticeCapability,
  PracticeGrounding,
  PracticeEvidenceUnit,
} from '#contracts/PracticeAssessment.js';
import type {
  PracticeCheckpoint,
  PracticeEvidence,
  PracticeEvaluation,
} from '#contracts/PracticeCheck.js';

export interface PreparedPracticeEvidence {
  evidence: PracticeEvidence[];
  units: PracticeEvidenceUnit[];
  capabilities: Map<string, PracticeCapability[]>;
  warnings: string[];
  extractorVersion: string;
}

export interface CriterionEvaluationInput {
  rubric: PracticeCheckpoint;
  prepared: PreparedPracticeEvidence;
  grounding: PracticeGrounding;
  locale: DesktopLocale;
}

/** Batch results retain criterion identity; one provider request can judge several criteria. */
export interface PracticeCriterionEvaluator {
  readonly id: string;
  readonly version: string;
  readonly available: boolean;
  supports(input: CriterionEvaluationInput): boolean;
  evaluate(input: CriterionEvaluationInput, signal: AbortSignal): Promise<PracticeEvaluation>;
}

export interface PracticeArtifactExtractor {
  readonly version: string;
  extract(evidence: PracticeEvidence, signal: AbortSignal): Promise<PracticeEvidenceUnit[]>;
}
