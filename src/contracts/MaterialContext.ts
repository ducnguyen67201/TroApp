import { z } from 'zod';
import { PracticeSuggestionSchema } from './PracticeCheck.js';

export const MaterialEvidenceOrigin = { SOURCE: 'source', SUGGESTION: 'suggestion' } as const;

export const MaterialContextStatus = {
  READY: 'ready',
  NEEDS_EXPANSION: 'needs_expansion',
} as const;

export const MaterialSourceScope = {
  PASSAGE: 'passage',
  NEIGHBORS: 'neighbors',
  SOURCE_UNIT: 'source_unit',
} as const;

export const MaterialContextLimits = {
  PASSAGES: 600,
  PASSAGE_CHARACTERS: 8000,
  TARGET_TOKENS: 4000,
  MAXIMUM_TOKENS: 8000,
  READ_TOKENS: 1200,
  SEARCH_TOKENS: 800,
} as const;

/** Provider format is structural; owning application code validates source bindings. */
export const CitedMaterialNoteSchema = z.strictObject({
  text: z.string().min(1).max(1000),
  origin: z.enum(MaterialEvidenceOrigin),
  sourceIds: z.array(z.uuid()).max(30),
});

export const DocumentBriefContentSchema = z.strictObject({
  purpose: CitedMaterialNoteSchema,
  topics: z.array(z.string().min(1).max(100)).max(8),
  setup: z.array(CitedMaterialNoteSchema).max(12),
  practice: z.array(CitedMaterialNoteSchema).max(12),
  examples: z.array(CitedMaterialNoteSchema).max(12),
  uncertainties: z.array(z.string().max(500)).max(12),
});

export const DocumentBriefSchema = DocumentBriefContentSchema.extend({
  materialId: z.uuid(),
  sourceDigest: z.string().max(64),
  teacherNote: z.string().max(4000).nullable(),
});

export const MaterialSourcePassageSchema = z.strictObject({
  id: z.uuid(),
  materialId: z.uuid(),
  sourceUnitId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  location: z.string().max(200),
  heading: z.string().max(200),
  text: z.string().max(MaterialContextLimits.PASSAGE_CHARACTERS),
  teacherNote: z.string().max(10_000).nullable(),
  warnings: z.array(z.string().max(500)).max(10),
});

export const MaterialPacketSchema = z.strictObject({
  schemaVersion: z.literal(2),
  courseRevisionId: z.uuid(),
  activityId: z.uuid(),
  summary: z.string().max(4000),
  teacherInstructions: z.string().max(4000),
  setup: z.array(CitedMaterialNoteSchema).max(174),
  documentNotes: z
    .array(z.strictObject({ materialId: z.uuid(), text: z.string().max(4000) }))
    .max(12),
  documentIndex: z
    .array(
      z.strictObject({
        materialId: z.uuid(),
        name: z.string().max(200),
        topics: z.array(z.string().max(100)).max(8),
      }),
    )
    .max(12),
  evidence: z.array(MaterialSourcePassageSchema).max(MaterialContextLimits.PASSAGES),
});

export const MaterialContextSelectionSchema = z.strictObject({
  status: z.enum(MaterialContextStatus),
  packet: MaterialPacketSchema.nullable(),
  missingSourceIds: z.array(z.uuid()).max(MaterialContextLimits.PASSAGES),
  omittedCount: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});

export const MaterialSearchResultSchema = z.strictObject({
  matches: z
    .array(
      z.strictObject({
        sourceId: z.uuid(),
        materialId: z.uuid(),
        location: z.string().max(200),
        excerpt: z.string().max(800),
      }),
    )
    .max(8),
  hasMore: z.boolean(),
});

export const MaterialSourceReadSchema = z.strictObject({
  evidence: z.array(MaterialSourcePassageSchema).max(30),
  continuationSourceIds: z.array(z.uuid()).max(MaterialContextLimits.PASSAGES),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const MaterialCompositionSchema = z.strictObject({
  summary: z.string().max(4000),
  sections: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(200),
        instruction: z.string().min(1).max(4000),
        sourcePageIds: z.array(z.uuid()).min(1).max(120),
        setup: z.array(CitedMaterialNoteSchema).max(30),
        practiceSuggestions: z.array(PracticeSuggestionSchema).max(4).optional(),
      }),
    )
    .min(1)
    .max(20),
  questions: z.array(z.string().max(1000)).max(12),
});

export const MaterialGenerationOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('brief'), brief: DocumentBriefContentSchema }),
  z.strictObject({ kind: z.literal('composition'), composition: MaterialCompositionSchema }),
]);

export type MaterialGenerationOutput = z.infer<typeof MaterialGenerationOutputSchema>;

export const MaterialDerivationState = {
  PREPARING: 'preparing',
  COMPLETED: 'completed',
  UNCERTAIN: 'uncertain',
  REJECTED: 'rejected',
} as const;

export const MaterialDerivationSchema = z.strictObject({
  classId: z.uuid(),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.uuid(),
  claimId: z.uuid(),
  collectionVersion: z.number().int().nonnegative(),
  state: z.enum(MaterialDerivationState),
  reservedInput: z.number().int().nonnegative(),
  reservedOutput: z.number().int().nonnegative(),
  usedInput: z.number().int().nonnegative().nullable(),
  usedOutput: z.number().int().nonnegative().nullable(),
  result: MaterialGenerationOutputSchema.nullable(),
});

export type DocumentBriefContent = z.infer<typeof DocumentBriefContentSchema>;

export type DocumentBrief = z.infer<typeof DocumentBriefSchema>;

export type MaterialSourcePassage = z.infer<typeof MaterialSourcePassageSchema>;

export type MaterialPacket = z.infer<typeof MaterialPacketSchema>;

export type MaterialContextSelection = z.infer<typeof MaterialContextSelectionSchema>;

export type MaterialSearchResult = z.infer<typeof MaterialSearchResultSchema>;

export type MaterialSourceRead = z.infer<typeof MaterialSourceReadSchema>;

export type MaterialDerivation = z.infer<typeof MaterialDerivationSchema>;
