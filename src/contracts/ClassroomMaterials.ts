import {
  DocumentBriefSchema,
  MaterialSourcePassageSchema,
  CitedMaterialNoteSchema,
  MaterialContextSelectionSchema,
} from './MaterialContext.js';
import { z } from 'zod';
import { PracticeCheckpointSchema } from './PracticeCheck.js';

export const MaterialLimits = {
  FILE_BYTES: 8_000_000,
  COLLECTION_BYTES: 24_000_000,
  FILE_COUNT: 12,
  PAGE_COUNT: 120,
  EXTRACTED_CHARACTERS: 200_000,
  PREPARATION_MS: 240_000,
  LEASE_MS: 660_000,
} as const;

export const MaterialState = {
  COLLECTING: 'collecting',
  QUEUED: 'queued',
  PREPARING: 'preparing',
  REVIEW: 'review',
  APPROVED: 'approved',
  FAILED: 'failed',
} as const;

export const MaterialFailure = {
  INVALID: 'invalid',
  FORBIDDEN: 'forbidden',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
} as const;

export type MaterialFailure = (typeof MaterialFailure)[keyof typeof MaterialFailure];

export const MaterialIssue = {
  INVALID_FILE: 'invalid_file',
  TOO_LARGE: 'too_large',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PREPARATION_FAILED: 'preparation_failed',
  CITATION_VALIDATION_FAILED: 'citation_validation_failed',
  GENERATION_LIMIT: 'generation_limit',
  REVIEW_REQUIRED: 'review_required',
} as const;
const title = z.string().trim().min(1).max(200);
export const MaterialFilenameSchema = title.refine(
  (name) =>
    Array.from(name).every(
      (character) => character.charCodeAt(0) >= 32 && character !== '/' && character !== '\\',
    ),
  'Filename must not contain path separators or control characters.',
);

export const MaterialSourceSchema = z.strictObject({
  id: z.uuid(),
  name: title,
  bytes: z.number().int().nonnegative().max(MaterialLimits.FILE_BYTES),
  digest: z.string().max(64),
  url: z.url().max(2000).nullable(),
});

export const MaterialPageSchema = z.strictObject({
  id: z.uuid(),
  materialId: z.uuid(),
  location: title,
  extractedText: z.string().max(50_000),
  preparedNote: z.string().max(10_000),
  teacherNote: z.string().max(10_000).nullable(),
  warnings: z.array(z.string().max(500)).max(10),
});

export const MaterialSectionSchema = z.strictObject({
  id: z.uuid(),
  title,
  instruction: z.string().trim().min(1).max(4000),
  sourcePageIds: z.array(z.uuid()).min(1).max(MaterialLimits.PAGE_COUNT),
  setup: z.array(CitedMaterialNoteSchema).max(30).optional(),
  practiceCheckpoints: z.array(PracticeCheckpointSchema).max(4).optional(),
});

export const LegacyMaterialDraftSchema = z
  .strictObject({
    summary: z.string().max(4000),
    sections: z.array(MaterialSectionSchema).min(1).max(20),
    pages: z.array(MaterialPageSchema).min(1).max(MaterialLimits.PAGE_COUNT),
    questions: z.array(z.string().max(1000)).max(12),
  })
  .refine(
    (draft) =>
      new Set(draft.sections.map((section) => section.id)).size === draft.sections.length &&
      new Set(draft.pages.map((page) => page.id)).size === draft.pages.length &&
      JSON.stringify(draft).length <= 700_000,
    'Draft IDs or size invalid.',
  );

export const MaterialSectionV2Schema = MaterialSectionSchema;

export const MaterialDraftV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    summary: z.string().max(4000),
    sections: z.array(MaterialSectionV2Schema).min(1).max(20),
    pages: z.array(MaterialPageSchema).min(1).max(MaterialLimits.PAGE_COUNT),
    documents: z.array(DocumentBriefSchema).min(1).max(MaterialLimits.FILE_COUNT),
    passages: z.array(MaterialSourcePassageSchema).min(1).max(600),
    questions: z.array(z.string().max(1000)).max(12),
  })
  .superRefine((draft, context) => {
    const pages = new Map(draft.pages.map((page) => [page.id, page]));
    const passages = new Map(draft.passages.map((passage) => [passage.id, passage]));
    const invalid =
      pages.size !== draft.pages.length ||
      passages.size !== draft.passages.length ||
      new Set(draft.documents.map((document) => document.materialId)).size !==
        draft.documents.length ||
      new Set(draft.sections.map((section) => section.id)).size !== draft.sections.length ||
      draft.passages.some((passage) => {
        const page = pages.get(passage.sourceUnitId);
        return (
          !page ||
          page.materialId !== passage.materialId ||
          passage.end < passage.start ||
          passage.end > page.extractedText.length ||
          page.extractedText.slice(passage.start, passage.end) !== passage.text
        );
      }) ||
      draft.pages.some(
        (page) => !draft.passages.some((passage) => passage.sourceUnitId === page.id),
      ) ||
      draft.sections.some(
        (section) =>
          section.sourcePageIds.some((id) => !pages.has(id)) ||
          (section.practiceCheckpoints ?? []).some((checkpoint) =>
            checkpoint.criteria.some(
              (criterion) =>
                criterion.sourceIds.some((id) => !pages.has(id)) ||
                (checkpoint.origin === 'source' && criterion.sourceIds.length === 0),
            ),
          ) ||
          (section.setup ?? []).some((note) => note.sourceIds.some((id) => !passages.has(id))),
      ) ||
      draft.documents.some((document) =>
        [document.purpose, ...document.setup, ...document.practice, ...document.examples].some(
          (note) =>
            (note.origin === 'source' && note.sourceIds.length === 0) ||
            note.sourceIds.some((id) => passages.get(id)?.materialId !== document.materialId),
        ),
      ) ||
      draft.passages.some(
        (passage) =>
          !draft.documents.some((document) => document.materialId === passage.materialId),
      );
    if (invalid) {
      context.addIssue({ code: 'custom', message: 'Invalid source bindings or duplicate IDs.' });
    }
  });

export const MaterialDraftSchema = z.union([MaterialDraftV2Schema, LegacyMaterialDraftSchema]);

export type MaterialDraftV2 = z.infer<typeof MaterialDraftV2Schema>;

export const MaterialPreparationPhase = {
  PREPARING: 'preparing',
  CHECKING_REFERENCES: 'checking_references',
  CORRECTING_REFERENCES: 'correcting_references',
  READY: 'ready',
} as const;

export const MaterialPreparationProgressSchema = z.strictObject({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  phase: z.enum(MaterialPreparationPhase).optional(),
});

export const MaterialCollectionSchema = z.strictObject({
  classId: z.uuid(),
  version: z.number().int().nonnegative(),
  state: z.enum(MaterialState),
  sources: z.array(MaterialSourceSchema).max(MaterialLimits.FILE_COUNT),
  teacherInstructions: z.string().max(4000),
  draft: MaterialDraftSchema.nullable(),
  issue: z.enum(MaterialIssue).nullable(),
  leaseUntil: z.iso.datetime().nullable(),
  preparedAt: z.iso.datetime().nullable(),
  approvedCourseId: z.uuid().nullable(),
  preparationProgress: MaterialPreparationProgressSchema.nullable().optional(),
});

export const MaterialCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('read'),
    classId: z.uuid(),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('upload'),
    classId: z.uuid(),
    version: z.number().int().nonnegative(),
    name: MaterialFilenameSchema,
    data: z
      .string()
      .min(4)
      .max(Math.ceil(MaterialLimits.FILE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('add-link'),
    classId: z.uuid(),
    version: z.number().int().nonnegative(),
    name: title,
    url: z
      .url()
      .max(2000)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      }),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('remove'),
    classId: z.uuid(),
    version: z.number().int().nonnegative(),
    materialId: z.uuid(),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('prepare'),
    classId: z.uuid(),
    version: z.number().int().nonnegative(),
    teacherInstructions: z.string().max(4000),
    locale: z.enum(['en', 'vi']),
    revisionRequest: z.string().trim().min(1).max(4000).optional(),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('save-review'),
    classId: z.uuid(),
    version: z.number().int().nonnegative(),
    teacherInstructions: z.string().max(4000),
    summary: z.string().max(4000),
    sections: z
      .array(z.union([MaterialSectionV2Schema, MaterialSectionSchema]))
      .min(1)
      .max(20),
    notes: z
      .array(z.strictObject({ pageId: z.uuid(), text: z.string().max(10_000).nullable() }))
      .max(MaterialLimits.PAGE_COUNT),
    documentNotes: z
      .array(z.strictObject({ materialId: z.uuid(), text: z.string().max(4000).nullable() }))
      .max(12)
      .optional(),
    resolvedQuestions: z.boolean(),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('approve'),
    classId: z.uuid(),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('download'),
    classId: z.uuid(),
    materialId: z.uuid(),
  }),
]);

export const MaterialReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('collection'), collection: MaterialCollectionSchema }),
  z.strictObject({
    kind: z.literal('download'),
    name: MaterialFilenameSchema,
    data: z.string().max(Math.ceil(MaterialLimits.FILE_BYTES / 3) * 4),
  }),
  z.strictObject({
    kind: z.literal('failed'),
    code: z.enum(MaterialFailure),
    issue: z.enum(MaterialIssue).optional(),
  }),
]);

export const LegacyMaterialLessonContextSchema = z.strictObject({
  summary: z.string().max(4000),
  teacherInstructions: z.string().max(4000),
  pages: z.array(MaterialPageSchema).max(MaterialLimits.PAGE_COUNT),
  pageIndex: z
    .array(z.strictObject({ id: z.uuid(), materialId: z.uuid(), location: title }))
    .max(MaterialLimits.PAGE_COUNT),
  sources: z.array(MaterialSourceSchema).max(MaterialLimits.FILE_COUNT),
});

export const MaterialLessonContextSchema = z.union([
  LegacyMaterialLessonContextSchema.extend({
    ...MaterialContextSelectionSchema.shape,
    schemaVersion: z.literal(2),
  }),
  LegacyMaterialLessonContextSchema,
]);

export type MaterialSource = z.infer<typeof MaterialSourceSchema>;

export type MaterialPage = z.infer<typeof MaterialPageSchema>;

export type MaterialDraft = z.infer<typeof MaterialDraftSchema>;

export type MaterialCollection = z.infer<typeof MaterialCollectionSchema>;

export type MaterialCommand = z.infer<typeof MaterialCommandSchema>;

export type MaterialReply = z.infer<typeof MaterialReplySchema>;

export type MaterialLessonContext = z.infer<typeof MaterialLessonContextSchema>;

/** Private preparation state carries locale and resolved-question acknowledgement outside UI drafts. */
export const StoredMaterialCollectionSchema = MaterialCollectionSchema.extend({
  revisionRequest: z.string().trim().min(1).max(4000).nullable().optional(),
  extractionVersion: z.string().max(100).nullable().optional(),
  jobId: z.uuid().nullable().optional(),
  preparationProgress: MaterialPreparationProgressSchema.nullable().default(null),
  locale: z.enum(['en', 'vi']),
  resolvedQuestions: z.boolean(),
  extractedPages: z.array(MaterialPageSchema).max(MaterialLimits.PAGE_COUNT).default([]),
});

export type StoredMaterialCollection = z.infer<typeof StoredMaterialCollectionSchema>;

export const MaterialPublicationSchema = z.strictObject({
  courseId: z.uuid(),
  classId: z.uuid(),
  teacherInstructions: z.string().max(4000),
  draft: MaterialDraftSchema,
  sources: z.array(MaterialSourceSchema).max(MaterialLimits.FILE_COUNT),
});

export type MaterialPublication = z.infer<typeof MaterialPublicationSchema>;
