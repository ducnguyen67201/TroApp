import type {
  MaterialGenerationOutput,
  MaterialSourcePassage,
} from '#contracts/MaterialContext.js';
import type { MaterialStageInput } from './MaterialGeneration.js';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
  type MaterialPreparationDiagnostic,
} from './MaterialPreparationError.js';

type Composition = Extract<MaterialGenerationOutput, { kind: 'composition' }>['composition'];
type CompositionInput = Extract<MaterialStageInput, { kind: 'composition' }>;

/** Only a completed response rejected by citation validation can schedule a repair.
 * The draft is transient reference data and must never be passed to ordinary logging. */
export class MaterialCitationRejection extends MaterialPreparationError {
  constructor(
    diagnostic: MaterialPreparationDiagnostic,
    readonly composition: Composition,
  ) {
    super(diagnostic);
  }
}

/** One bounded repair packet, using original passages rather than a generated brief as evidence. */
export function buildMaterialCitationRepair(
  input: CompositionInput,
  rejection: MaterialCitationRejection,
  passages: MaterialSourcePassage[],
): CompositionInput {
  const issues = (rejection.diagnostic.referenceIssues ?? []).slice(0, 10);
  const relevantPages = new Set<string>();
  for (const issue of issues) {
    const mapped = input.sourceMap.find((source) => source.passageId === issue.sourceId);
    if (mapped) {
      relevantPages.add(mapped.pageId);
    }
    const sectionIndex = /^composition\.sections\[(\d+)\]/.exec(issue.path)?.[1];
    if (sectionIndex !== undefined) {
      for (const id of rejection.composition.sections[Number(sectionIndex)]?.sourcePageIds ?? []) {
        relevantPages.add(id);
      }
    }
  }
  const allowedPassages = new Set(input.sourceMap.map((source) => source.passageId));
  const candidates = passages.filter((passage) => allowedPassages.has(passage.id));
  const evidence = [
    ...candidates.filter((passage) => relevantPages.has(passage.sourceUnitId)),
    ...candidates.filter((passage) => !relevantPages.has(passage.sourceUnitId)),
  ].slice(0, 8);
  return {
    ...input,
    citationRepair: {
      previousComposition: rejection.composition,
      issues,
      issueCount: rejection.diagnostic.referenceIssueCount ?? issues.length,
      evidence,
    },
  };
}

/** Citation repair can change reference arrays only; it cannot rewrite teacher wording,
 * remove exercises or downgrade source requirements into suggestions. */
export function validateMaterialCitationRepair(previous: Composition, repaired: Composition): void {
  if (
    JSON.stringify(readCompositionContent(previous)) !==
    JSON.stringify(readCompositionContent(repaired))
  ) {
    throw new MaterialPreparationError({
      reason: MaterialPreparationReason.CITATION_REPAIR_CHANGED_CONTENT,
    });
  }
}

function readCompositionContent(composition: Composition) {
  return {
    summary: composition.summary,
    questions: composition.questions,
    sections: composition.sections.map((section) => ({
      title: section.title,
      instruction: section.instruction,
      setup: section.setup.map((note) => ({ text: note.text, origin: note.origin })),
      practiceSuggestions: (section.practiceSuggestions ?? []).map((suggestion) => ({
        title: suggestion.title,
        task: suggestion.task,
        origin: suggestion.origin,
        criteria: suggestion.criteria.map((criterion) => ({
          description: criterion.description,
          required: criterion.required,
          evidenceNeeded: criterion.evidenceNeeded,
        })),
      })),
    })),
  };
}
