import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { PracticeSuggestionSchema } from '#contracts/PracticeCheck.js';
import {
  CitedMaterialNoteSchema,
  MaterialEvidenceOrigin,
  MaterialCompositionSchema,
} from '#contracts/MaterialContext.js';
import type { MaterialStageInput } from '../application/MaterialGeneration.js';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
} from '../application/MaterialPreparationError.js';

/** Shared enum definitions keep up to 120 pages + 600 passages within provider schema limits.
 * Enum chunks also keep each string enum below the provider's per-enum character limit. */
function buildReferenceIdSchema(ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) {
    return z.string();
  }
  const groups = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 250) {
    groups.push(z.enum(uniqueIds.slice(offset, offset + 250)));
  }
  return groups.length === 1 ? (groups[0] ?? z.string()) : z.union(groups);
}

export function buildMaterialCompositionSchema(
  input: Extract<MaterialStageInput, { kind: 'composition' }>,
) {
  if (!input.sourceUnits.length) {
    throw new MaterialPreparationError({
      reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
    });
  }
  const pageId = buildReferenceIdSchema(input.sourceUnits.map((unit) => unit.id));
  const passageIds = input.sourceMap.map((source) => source.passageId);
  const passageId = buildReferenceIdSchema(passageIds);
  const suggestionNote = CitedMaterialNoteSchema.extend({
    origin: z.literal(MaterialEvidenceOrigin.SUGGESTION),
    sourceIds: z.array(passageId).max(passageIds.length ? 30 : 0),
  });
  const note = passageIds.length
    ? z.union([
        CitedMaterialNoteSchema.extend({
          origin: z.literal(MaterialEvidenceOrigin.SOURCE),
          sourceIds: z.array(passageId).min(1).max(30),
        }),
        suggestionNote,
      ])
    : suggestionNote;
  const criterion = PracticeSuggestionSchema.shape.criteria.element;
  const practice = z.union([
    PracticeSuggestionSchema.extend({
      origin: z.literal(MaterialEvidenceOrigin.SOURCE),
      criteria: z
        .array(criterion.extend({ sourceIds: z.array(pageId).min(1).max(8) }))
        .min(1)
        .max(8),
    }),
    PracticeSuggestionSchema.extend({
      origin: z.literal(MaterialEvidenceOrigin.SUGGESTION),
      criteria: z
        .array(criterion.extend({ sourceIds: z.array(pageId).max(8) }))
        .min(1)
        .max(8),
    }),
  ]);
  return MaterialCompositionSchema.extend({
    sections: z
      .array(
        MaterialCompositionSchema.shape.sections.element.extend({
          sourcePageIds: z.array(pageId).min(1).max(120),
          setup: z.array(note).max(30),
          practiceSuggestions: z.array(practice).max(4),
        }),
      )
      .min(1)
      .max(20),
  });
}

/** The wire schema constrains allowed IDs. Parse the completed response structurally first,
 * so the application can diagnose and repair a citation violation from a completed response. */
export function buildMaterialCompositionFormat(
  input: Extract<MaterialStageInput, { kind: 'composition' }>,
) {
  const format = zodTextFormat(
    MaterialCompositionSchema.extend({
      sections: z
        .array(
          MaterialCompositionSchema.shape.sections.element.extend({
            practiceSuggestions: z.array(PracticeSuggestionSchema).max(4),
          }),
        )
        .min(1)
        .max(20),
    }),
    'class_composition',
  );
  format.schema = z.toJSONSchema(buildMaterialCompositionSchema(input), {
    target: 'draft-7',
    reused: 'ref',
  });
  return format;
}
