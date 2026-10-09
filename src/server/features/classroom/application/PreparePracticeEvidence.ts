import { PracticeCapability } from '#contracts/PracticeAssessment.js';
import {
  PracticeEvidenceKind,
  PracticeFailure,
  PracticeLimits,
  type PracticeEvidence,
} from '#contracts/PracticeCheck.js';
import { PracticeError } from '../domain/PracticeFindings.js';
import type {
  PracticeArtifactExtractor,
  PreparedPracticeEvidence,
} from './PracticeCriterionEvaluator.js';

/** Keeps derived units tied to original evidence IDs; never executes submitted content. */
export class PreparePracticeEvidence {
  constructor(private readonly extractor?: PracticeArtifactExtractor) {}

  async prepare(
    evidence: PracticeEvidence[],
    signal: AbortSignal,
  ): Promise<PreparedPracticeEvidence> {
    const prepared: PreparedPracticeEvidence = {
      evidence,
      units: [],
      capabilities: new Map(),
      warnings: [],
      extractorVersion: this.extractor?.version ?? 'text-image-v1',
    };
    for (const item of evidence) {
      signal.throwIfAborted();
      if (item.kind === PracticeEvidenceKind.IMAGE) {
        prepared.capabilities.set(item.id, [PracticeCapability.IMAGE]);
      } else if (item.kind === PracticeEvidenceKind.TEXT) {
        prepared.units.push({ evidenceId: item.id, location: 'Text', text: item.text });
        prepared.capabilities.set(item.id, [PracticeCapability.TEXT]);
      } else {
        if (!this.extractor) {
          throw new PracticeError(PracticeFailure.UNAVAILABLE);
        }
        const units = await this.extractor.extract(item, signal);
        prepared.units.push(...units);
        prepared.capabilities.set(item.id, [
          ...(units.some((unit) => unit.text.trim()) ? [PracticeCapability.TEXT] : []),
          ...(item.mediaType === 'application/x.scratch.sb3'
            ? [PracticeCapability.PROJECT_STRUCTURE]
            : []),
        ]);
        prepared.warnings.push(
          item.mediaType === 'application/pdf'
            ? 'PDF text extraction does not verify page layout, images or scanned content.'
            : 'Scratch structure was read without executing the project.',
        );
      }
    }
    if (
      prepared.units.length > 120 ||
      prepared.units.reduce((total, unit) => total + unit.text.length, 0) >
        PracticeLimits.TEXT_CHARACTERS
    ) {
      throw new PracticeError(PracticeFailure.LIMIT);
    }
    signal.throwIfAborted();
    return prepared;
  }
}
