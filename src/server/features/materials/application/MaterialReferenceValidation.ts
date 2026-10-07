import { z } from 'zod';
import {
  MaterialEvidenceOrigin,
  type DocumentBriefContent,
  type MaterialGenerationOutput,
} from '#contracts/MaterialContext.js';
import { MaterialGenerationStage, type MaterialStageInput } from './MaterialGeneration.js';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
  MaterialReferenceFailure,
  MaterialReferenceKind,
  type MaterialReferenceIssue,
} from './MaterialPreparationError.js';

const maximumReportedIssues = 10;
const sourceIdSchema = z.uuid();

/** Count every rejected citation, but retain only bounded structural diagnostics.
 * Paths are constructed here; only UUIDs pass into logs, never generated prose. */
function createReferenceValidation(pageIds: ReadonlySet<string>, passageIds: ReadonlySet<string>) {
  let issueCount = 0;
  const issues: MaterialReferenceIssue[] = [];
  const recordIssue = (issue: MaterialReferenceIssue): void => {
    issueCount += 1;
    if (issues.length < maximumReportedIssues) {
      issues.push(issue);
    }
  };
  return {
    validate(
      sourceIds: readonly string[],
      required: boolean,
      expectedKind: MaterialReferenceKind,
      path: string,
    ): void {
      const allowed = expectedKind === MaterialReferenceKind.PAGE ? pageIds : passageIds;
      const other = expectedKind === MaterialReferenceKind.PAGE ? passageIds : pageIds;
      if (required && sourceIds.length === 0) {
        recordIssue({
          path,
          reason: MaterialReferenceFailure.MISSING,
          expectedKind,
          allowedReferenceCount: allowed.size,
        });
      }
      sourceIds.forEach((id, index) => {
        if (allowed.has(id)) {
          return;
        }
        const knownOtherKind = other.has(id);
        const sourceId = sourceIdSchema.safeParse(id);
        recordIssue({
          path: `${path}[${String(index)}]`,
          reason: knownOtherKind
            ? MaterialReferenceFailure.WRONG_KIND
            : MaterialReferenceFailure.NOT_ALLOWED,
          expectedKind,
          ...(knownOtherKind
            ? {
                actualKind:
                  expectedKind === MaterialReferenceKind.PAGE
                    ? MaterialReferenceKind.PASSAGE
                    : MaterialReferenceKind.PAGE,
              }
            : {}),
          ...(sourceId.success ? { sourceId: sourceId.data } : {}),
          allowedReferenceCount: allowed.size,
        });
      });
    },
    finish(generationStage: MaterialStageInput['kind']): void {
      if (issueCount === 0) {
        return;
      }
      throw new MaterialPreparationError({
        reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
        generationStage,
        referenceIssueCount: issueCount,
        referenceIssues: issues,
        referenceIssuesTruncated: issueCount > issues.length,
        allowedPageCount: pageIds.size,
        allowedPassageCount: passageIds.size,
      });
    },
  };
}

export function validateBriefReferences(
  brief: DocumentBriefContent,
  sourceIds: readonly string[],
  pageIds: readonly string[] = [],
): void {
  const validation = createReferenceValidation(new Set(pageIds), new Set(sourceIds));
  const validateNote = (note: DocumentBriefContent['purpose'], path: string): void => {
    validation.validate(
      note.sourceIds,
      note.origin === MaterialEvidenceOrigin.SOURCE,
      MaterialReferenceKind.PASSAGE,
      `${path}.sourceIds`,
    );
  };
  validateNote(brief.purpose, 'brief.purpose');
  for (const group of ['setup', 'practice', 'examples'] as const) {
    brief[group].forEach((note, index) => {
      validateNote(note, `brief.${group}[${String(index)}]`);
    });
  }
  validation.finish(MaterialGenerationStage.BRIEF);
}

export function validateCompositionReferences(
  composition: Extract<MaterialGenerationOutput, { kind: 'composition' }>['composition'],
  input: Extract<MaterialStageInput, { kind: 'composition' }>,
): void {
  const pageIds = new Set(input.sourceUnits.map((unit) => unit.id));
  const passageIds = new Set(input.sourceMap.map((source) => source.passageId));
  const validation = createReferenceValidation(pageIds, passageIds);
  composition.sections.forEach((section, sectionIndex) => {
    const path = `composition.sections[${String(sectionIndex)}]`;
    // Nonempty section bindings are enforced by the owning generation schema.
    validation.validate(
      section.sourcePageIds,
      false,
      MaterialReferenceKind.PAGE,
      `${path}.sourcePageIds`,
    );
    (section.practiceSuggestions ?? []).forEach((checkpoint, checkpointIndex) => {
      checkpoint.criteria.forEach((criterion, criterionIndex) => {
        validation.validate(
          criterion.sourceIds,
          checkpoint.origin === MaterialEvidenceOrigin.SOURCE,
          MaterialReferenceKind.PAGE,
          `${path}.practiceSuggestions[${String(checkpointIndex)}].criteria[${String(criterionIndex)}].sourceIds`,
        );
      });
    });
    section.setup.forEach((note, noteIndex) => {
      validation.validate(
        note.sourceIds,
        note.origin === MaterialEvidenceOrigin.SOURCE,
        MaterialReferenceKind.PASSAGE,
        `${path}.setup[${String(noteIndex)}].sourceIds`,
      );
    });
  });
  validation.finish(MaterialGenerationStage.COMPOSITION);
}
