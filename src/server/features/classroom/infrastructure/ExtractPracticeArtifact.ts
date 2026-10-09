import { randomUUID } from 'node:crypto';
import { PracticeEvidenceKind, type PracticeEvidence } from '#contracts/PracticeCheck.js';
import type { PracticeEvidenceUnit } from '#contracts/PracticeAssessment.js';
import type { MaterialExtractor } from '../../materials/application/MaterialPreparation.js';
import type { PracticeArtifactExtractor } from '../application/PracticeCriterionEvaluator.js';

/** Reuses bounded material parsing with student-owned IDs; does not fetch links or execute projects. */
export class ExtractPracticeArtifact implements PracticeArtifactExtractor {
  readonly version = 'practice-document-v1';
  constructor(private readonly extractor: MaterialExtractor) {}

  async extract(evidence: PracticeEvidence, signal: AbortSignal): Promise<PracticeEvidenceUnit[]> {
    if (evidence.kind !== PracticeEvidenceKind.DOCUMENT) {
      return [];
    }
    signal.throwIfAborted();
    const classId = randomUUID();
    const name = evidence.mediaType === 'application/pdf' ? 'Work.pdf' : 'Work.sb3';
    const bytes = Buffer.from(evidence.base64, 'base64');
    const pages = await this.extractor.extract(
      {
        id: evidence.id,
        name,
        bytes: bytes.length,
        url: null,
        digest: '',
      },
      { id: evidence.id, classId, name, bytes },
    );
    signal.throwIfAborted();
    return pages.map((page) => ({
      evidenceId: evidence.id,
      location: page.location,
      text: page.extractedText,
    }));
  }
}
