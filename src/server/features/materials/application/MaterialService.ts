import { projectMaterialReply } from './MaterialCompatibility.js';
import { MaterialFailure } from '#contracts/ClassroomMaterials.js';
import { createHash, randomUUID } from 'node:crypto';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomFailure,
  ClassroomStatus,
  CourseContentSchema,
  SubmissionRequirement,
} from '#contracts/Classroom.js';
import {
  MaterialFilenameSchema,
  MaterialDraftSchema,
  StoredMaterialCollectionSchema,
  MaterialIssue,
  MaterialLimits,
  MaterialState,
  type MaterialCommand,
  type MaterialReply,
  type StoredMaterialCollection,
  type MaterialPage,
} from '#contracts/ClassroomMaterials.js';
import type { ClassroomStore } from '../../classroom/application/ClassroomStore.js';
import { ClassroomError } from '../../classroom/domain/ClassroomRules.js';
import type {
  MaterialExtractor,
  MaterialPreparation,
  MaterialFile,
} from './MaterialPreparation.js';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
  type MaterialPreparationDiagnostic,
} from './MaterialPreparationError.js';
import { ZodError } from 'zod';

/** Authorizes collection changes, batches preparation, and publishes reviewed revisions atomically. */
export class MaterialService {
  constructor(
    private readonly store: ClassroomStore,
    private readonly extractor: MaterialExtractor,
    private readonly preparation: MaterialPreparation,
    private readonly now: () => Date = () => new Date(),
    private readonly reportFailure: (
      event: MaterialPreparationDiagnostic & {
        classId: string;
        stage: string;
        errorType: string;
        durationMs: number;
        sourceCount: number;
        pageCount: number;
      },
    ) => void = () => {},
  ) {}

  async execute(userId: string, command: MaterialCommand): Promise<MaterialReply> {
    const reply = await this.store.runAtomically(async (store): Promise<MaterialReply> => {
      const schoolClass = await store.readClass(command.classId);
      if (!schoolClass) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      const isTeacher =
        schoolClass.teacherId === userId &&
        (await store.readAccountRole(userId)) === AccountRole.TEACHER;
      if (command.kind === 'download') {
        if (!isTeacher) {
          const publication = await store.readMaterialPublication(schoolClass.courseRevisionId);
          if (
            !(await store.isEnrolled(schoolClass.id, userId)) ||
            !publication?.sources.some((source) => source.id === command.materialId)
          ) {
            throw new ClassroomError(ClassroomFailure.FORBIDDEN);
          }
        }
        const file = await store.readMaterialFile(command.materialId);
        if (!file || file.classId !== schoolClass.id) {
          throw new ClassroomError(ClassroomFailure.FORBIDDEN);
        }
        return {
          kind: 'download',
          name: file.name,
          data: Buffer.from(file.bytes).toString('base64'),
        };
      }
      if (!isTeacher) {
        throw new ClassroomError(ClassroomFailure.FORBIDDEN);
      }
      const collection =
        (await store.readMaterialCollection(schoolClass.id)) ?? emptyCollection(schoolClass.id);
      if (command.kind === 'read') {
        return this.reply(collection);
      }
      if (collection.version !== command.version) {
        throw new ClassroomError(ClassroomFailure.STALE);
      }
      if (
        collection.state === MaterialState.PREPARING ||
        collection.state === MaterialState.QUEUED
      ) {
        throw new ClassroomError(ClassroomFailure.STALE);
      }
      let next: StoredMaterialCollection = {
        ...collection,
        version: collection.version + 1,
        issue: null,
      };
      if (command.kind === 'upload' || command.kind === 'add-link') {
        if (collection.sources.length >= MaterialLimits.FILE_COUNT) {
          return { kind: 'failed', code: MaterialFailure.INVALID, issue: MaterialIssue.TOO_LARGE };
        }
        const id = randomUUID();
        const bytes = command.kind === 'upload' ? Buffer.from(command.data, 'base64') : null;
        if (
          bytes &&
          (!bytes.length ||
            bytes.length > MaterialLimits.FILE_BYTES ||
            !/\.(pdf|pptx|sb3|py|md|txt)$/i.test(command.name) ||
            !MaterialFilenameSchema.safeParse(command.name).success)
        ) {
          return {
            kind: 'failed',
            code: MaterialFailure.INVALID,
            issue: MaterialIssue.INVALID_FILE,
          };
        }
        if (
          bytes &&
          (await store.readMaterialStorageBytes(schoolClass.id)) + bytes.length >
            MaterialLimits.COLLECTION_BYTES
        ) {
          return { kind: 'failed', code: MaterialFailure.INVALID, issue: MaterialIssue.TOO_LARGE };
        }
        const source = {
          id,
          name: command.name,
          bytes: bytes?.length ?? 0,
          digest: bytes ? createHash('sha256').update(bytes).digest('hex') : '',
          url: command.kind === 'add-link' ? command.url : null,
        };
        if (bytes) {
          await store.saveMaterialFile({ id, classId: schoolClass.id, name: command.name, bytes });
        }
        next = {
          ...next,
          sources: [...collection.sources, source],
          state: MaterialState.COLLECTING,
        };
      } else if (command.kind === 'remove') {
        if (!collection.sources.some((source) => source.id === command.materialId)) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        await store.deleteUnpublishedMaterialFile(schoolClass.id, command.materialId);
        next = {
          ...next,
          sources: collection.sources.filter((source) => source.id !== command.materialId),
          state: MaterialState.COLLECTING,
        };
      } else if (command.kind === 'prepare') {
        if (!this.preparation.available) {
          return {
            kind: 'failed',
            code: MaterialFailure.UNAVAILABLE,
            issue: MaterialIssue.PROVIDER_UNAVAILABLE,
          };
        }
        if (!collection.sources.length) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        if (command.revisionRequest && !collection.draft) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        await store.reserveMaterialPreparation(userId, this.now().toISOString().slice(0, 10));
        next = {
          ...next,
          teacherInstructions: command.teacherInstructions,
          revisionRequest: command.revisionRequest ?? null,
          locale: command.locale,
          state: MaterialState.QUEUED,
          leaseUntil: null,
          resolvedQuestions: false,
          jobId: randomUUID(),
          preparationProgress: { completed: 0, total: collection.sources.length + 1 },
        };
      } else if (command.kind === 'save-review') {
        if (
          !collection.draft ||
          collection.state === MaterialState.COLLECTING ||
          collection.state === MaterialState.FAILED
        ) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        if ('schemaVersion' in collection.draft && command.materialSchemaVersion !== 2) {
          throw new ClassroomError(ClassroomFailure.STALE);
        }
        const draft = collection.draft;
        if (
          command.documentNotes &&
          (!('schemaVersion' in draft) ||
            new Set(command.documentNotes.map((note) => note.materialId)).size !==
              command.documentNotes.length ||
            command.documentNotes.some(
              (note) =>
                !draft.documents.some((document) => document.materialId === note.materialId),
            ))
        ) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        const ids = new Set(collection.draft.pages.map((page) => page.id));
        if (
          command.notes.length !== ids.size ||
          new Set(command.notes.map((note) => note.pageId)).size !== ids.size ||
          command.notes.some((note) => !ids.has(note.pageId)) ||
          command.sections.some((section) => section.sourcePageIds.some((id) => !ids.has(id)))
        ) {
          throw new ClassroomError(ClassroomFailure.INVALID);
        }
        next = {
          ...next,
          teacherInstructions: command.teacherInstructions,
          resolvedQuestions: command.resolvedQuestions,
          state: MaterialState.REVIEW,
          draft: MaterialDraftSchema.parse({
            ...collection.draft,
            ...('schemaVersion' in collection.draft
              ? {
                  documents: collection.draft.documents.map((document) => ({
                    ...document,
                    teacherNote:
                      command.documentNotes?.find((note) => note.materialId === document.materialId)
                        ?.text ??
                      (command.documentNotes?.some(
                        (note) => note.materialId === document.materialId,
                      )
                        ? null
                        : document.teacherNote),
                  })),
                }
              : {}),
            summary: command.summary,
            sections: command.sections.map((section) => ({
              ...section,
              ...('schemaVersion' in draft
                ? { setup: 'setup' in section ? section.setup : [] }
                : {}),
            })),
            pages: collection.draft.pages.map((page) => ({
              ...page,
              teacherNote: command.notes.find((note) => note.pageId === page.id)?.text ?? null,
            })),
          }),
        };
      } else {
        if (collection.state === MaterialState.APPROVED) {
          return this.reply(collection);
        }
        if (
          collection.state !== MaterialState.REVIEW ||
          !collection.draft ||
          !collection.resolvedQuestions
        ) {
          return {
            kind: 'failed',
            code: MaterialFailure.INVALID,
            issue: MaterialIssue.REVIEW_REQUIRED,
          };
        }
        if (
          (await store.listMeetings(schoolClass.id)).some(
            (meeting) => meeting.status === ClassroomStatus.LIVE,
          )
        ) {
          throw new ClassroomError(ClassroomFailure.STALE);
        }
        const content = CourseContentSchema.parse({
          modules: [
            {
              title: schoolClass.name,
              lessons: [
                {
                  title: schoolClass.name,
                  activities: collection.draft.sections.map((section) => ({
                    id: section.id,
                    title: section.title,
                    objective: section.title,
                    instructions: section.instruction,
                    prerequisites: [],
                    criteria: [
                      { id: randomUUID(), description: section.instruction.slice(0, 500) },
                    ],
                    materials: [],
                    submission: SubmissionRequirement.NONE,
                    ...(section.practiceCheckpoints
                      ? {
                          practiceCheckpoints: section.practiceCheckpoints.map((checkpoint) => ({
                            ...checkpoint,
                            rubricRevisionId: randomUUID(),
                          })),
                        }
                      : {}),
                  })),
                },
              ],
            },
          ],
        });
        const course = await store.saveCourse(userId, schoolClass.name, content);
        await store.saveMaterialPublication({
          courseId: course.id,
          classId: schoolClass.id,
          sources: collection.sources,
          teacherInstructions: collection.teacherInstructions,
          draft: collection.draft,
        });
        await store.updateClassCourse(schoolClass.id, course.id);
        next = { ...next, state: MaterialState.APPROVED, approvedCourseId: course.id };
      }
      const validated = StoredMaterialCollectionSchema.safeParse(next);
      if (!validated.success) {
        throw new ClassroomError(ClassroomFailure.INVALID);
      }
      await store.saveMaterialCollection(validated.data, collection.version);
      return this.reply(next);
    });
    return projectMaterialReply(reply, command.materialSchemaVersion);
  }

  /** One leased job at a time per runner. Expired in-flight calls fail visibly rather than bill twice. */
  async prepareNextCollection(): Promise<boolean> {
    const pending = (await this.store.listPendingMaterials(this.now()))[0];
    if (!pending) {
      return false;
    }
    if (pending.state === MaterialState.PREPARING) {
      await this.store.runAtomically((store) =>
        store.saveMaterialCollection(
          {
            ...pending,
            version: pending.version + 1,
            state: MaterialState.FAILED,
            issue: MaterialIssue.PREPARATION_FAILED,
            leaseUntil: null,
          },
          pending.version,
        ),
      );
      return true;
    }
    const schoolClass = await this.store.readClass(pending.classId);
    if (
      !schoolClass ||
      (await this.store.readAccountRole(schoolClass.teacherId)) !== AccountRole.TEACHER
    ) {
      await this.store.runAtomically((store) =>
        store.saveMaterialCollection(
          {
            ...pending,
            version: pending.version + 1,
            state: MaterialState.FAILED,
            issue: MaterialIssue.PREPARATION_FAILED,
            leaseUntil: null,
          },
          pending.version,
        ),
      );
      return true;
    }
    let claimed = {
      ...pending,
      jobId: pending.jobId ?? randomUUID(),
      version: pending.version + 1,
      state: MaterialState.PREPARING,
      leaseUntil: new Date(this.now().getTime() + MaterialLimits.LEASE_MS).toISOString(),
    };
    await this.store.runAtomically((store) =>
      store.saveMaterialCollection(claimed, pending.version),
    );
    let stage = 'extract_materials';
    const startedAt = this.now().getTime();
    try {
      const files: MaterialFile[] = [];
      const pages: MaterialPage[] = [];
      for (const source of claimed.sources) {
        const file = source.url ? null : await this.store.readMaterialFile(source.id);
        if (file) {
          files.push(file);
        }
        const cached =
          !this.extractor.version || claimed.extractionVersion === this.extractor.version
            ? claimed.extractedPages.filter((page) => page.materialId === source.id)
            : [];
        pages.push(...(cached.length ? cached : await this.extractor.extract(source, file)));
      }
      if (
        !pages.length ||
        pages.length > MaterialLimits.PAGE_COUNT ||
        pages.some((page) => page.extractedText.length > 50_000) ||
        pages.reduce((sum, page) => sum + page.extractedText.length, 0) >
          MaterialLimits.EXTRACTED_CHARACTERS
      ) {
        throw new MaterialPreparationError({ reason: MaterialPreparationReason.EXTRACTION_LIMIT });
      }
      const extracted = {
        ...claimed,
        version: claimed.version + 1,
        extractedPages: pages,
        extractionVersion: this.extractor.version ?? null,
      };
      await this.store.runAtomically((store) =>
        store.saveMaterialCollection(extracted, claimed.version),
      );
      claimed = extracted;
      stage = 'prepare_notes';
      const draft = MaterialDraftSchema.parse(
        await this.preparation.prepare({
          classId: claimed.classId,
          collectionVersion: claimed.version,
          jobId: claimed.jobId,
          previousDraft: claimed.draft,
          revisionRequest: claimed.revisionRequest ?? null,
          extractionVersion: claimed.extractionVersion ?? null,
          sources: claimed.sources,
          pages,
          files,
          teacherInstructions: claimed.teacherInstructions,
          locale: claimed.locale,
        }),
      );
      validatePreparedPages(
        pages.map((page) => page.id),
        draft,
      );
      if (
        'schemaVersion' in draft &&
        (draft.documents.length !== claimed.sources.length ||
          draft.documents.some(
            (document) =>
              !claimed.sources.some(
                (source) =>
                  source.id === document.materialId && source.digest === document.sourceDigest,
              ),
          ))
      ) {
        throw new MaterialPreparationError({
          reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
        });
      }
      if (
        draft.pages.some((page) => {
          const original = pages.find((item) => item.id === page.id);
          return (
            !original ||
            page.extractedText !== original.extractedText ||
            page.materialId !== original.materialId
          );
        })
      ) {
        throw new MaterialPreparationError({ reason: MaterialPreparationReason.SOURCE_CHANGED });
      }
      stage = 'save_review';
      await this.store.runAtomically((store) =>
        store.saveMaterialCollection(
          {
            ...claimed,
            version: claimed.version + 1,
            state: MaterialState.REVIEW,
            revisionRequest: null,
            leaseUntil: null,
            preparedAt: this.now().toISOString(),
            preparationProgress: {
              completed: claimed.sources.length + 1,
              total: claimed.sources.length + 1,
            },
            draft: {
              ...draft,
              ...('schemaVersion' in draft
                ? {
                    documents: draft.documents.map((document) => ({
                      ...document,
                      teacherNote:
                        claimed.draft && 'schemaVersion' in claimed.draft
                          ? (claimed.draft.documents.find(
                              (item) =>
                                item.materialId === document.materialId &&
                                item.sourceDigest === document.sourceDigest,
                            )?.teacherNote ?? null)
                          : null,
                    })),
                  }
                : {}),
              pages: draft.pages.map((page) => ({
                ...page,
                teacherNote:
                  claimed.draft?.pages.find(
                    (item) =>
                      item.id === page.id ||
                      (item.materialId === page.materialId && item.location === page.location),
                  )?.teacherNote ?? null,
              })),
            },
          },
          claimed.version,
        ),
      );
    } catch (error: unknown) {
      this.reportFailure({
        classId: claimed.classId,
        stage,
        errorType:
          error instanceof MaterialPreparationError
            ? error.name
            : error instanceof ZodError
              ? 'ZodError'
              : 'UnknownError',
        durationMs: this.now().getTime() - startedAt,
        sourceCount: claimed.sources.length,
        pageCount: claimed.extractedPages.length,
        ...(error instanceof MaterialPreparationError
          ? error.diagnostic
          : error instanceof ZodError
            ? {
                reason: MaterialPreparationReason.INVALID_DRAFT,
                validationIssueCount: error.issues.length,
              }
            : { reason: MaterialPreparationReason.UNKNOWN }),
      });
      await this.store.runAtomically((store) =>
        store.saveMaterialCollection(
          {
            ...claimed,
            version: claimed.version + 1,
            state: MaterialState.FAILED,
            issue: MaterialIssue.PREPARATION_FAILED,
            leaseUntil: null,
          },
          claimed.version,
        ),
      );
    }
    return true;
  }

  private reply(collection: StoredMaterialCollection): MaterialReply {
    return {
      kind: 'collection',
      collection: {
        classId: collection.classId,
        version: collection.version,
        state: collection.state,
        sources: collection.sources,
        teacherInstructions: collection.teacherInstructions,
        draft: collection.draft,
        issue: collection.issue,
        leaseUntil: collection.leaseUntil,
        preparedAt: collection.preparedAt,
        approvedCourseId: collection.approvedCourseId,
        preparationProgress: collection.preparationProgress,
      },
    };
  }
}

function emptyCollection(classId: string): StoredMaterialCollection {
  return {
    classId,
    version: 0,
    state: MaterialState.COLLECTING,
    sources: [],
    teacherInstructions: '',
    draft: null,
    issue: null,
    leaseUntil: null,
    preparedAt: null,
    approvedCourseId: null,
    locale: 'en',
    revisionRequest: null,
    resolvedQuestions: false,
    extractedPages: [],
    extractionVersion: null,
    jobId: null,
    preparationProgress: null,
  };
}

function validatePreparedPages(
  ids: string[],
  draft: import('#contracts/ClassroomMaterials.js').MaterialDraft,
): void {
  if (
    draft.pages.length !== ids.length ||
    new Set(draft.pages.map((page) => page.id)).size !== ids.length ||
    draft.pages.some((page) => !ids.includes(page.id)) ||
    draft.sections.some((section) => section.sourcePageIds.some((id) => !ids.includes(id)))
  ) {
    throw new MaterialPreparationError({
      reason: MaterialPreparationReason.INVALID_SOURCE_REFERENCES,
    });
  }
}
