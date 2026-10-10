import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { AccountRole } from '#contracts/AccountRole.js';
import { ClassSchema } from '#contracts/Classroom.js';
import { MaterialPublicationSchema } from '#contracts/ClassroomMaterials.js';
import { LessonStatus, LessonPhase, PrivateNoteSchema } from '#contracts/GuidedLessons.js';
import { LessonArtifactKind } from '../features/guidedLessons/application/LessonPorts.js';
import {
  LessonRecordSchema,
  LessonReleaseSchema,
  LessonProgressSchema,
  LessonBudgetSchema,
  LessonReceiptSchema,
  LessonRequestSchema,
  type LessonRecord,
  type LessonRelease,
  type LessonProgress,
  type LessonBudget,
  type LessonReceipt,
  type LessonRequest,
  type LessonNote,
} from '../features/guidedLessons/application/LessonState.js';
import type {
  GuidedLessonStore,
  StoredLessonArtifact,
} from '../features/guidedLessons/application/GuidedLessonStore.js';
import { LessonError, LessonFailure } from '../features/guidedLessons/application/LessonFailure.js';
import { runClassroomTransactionWithRetries } from './RetryClassroomTransaction.js';
import { z } from 'zod';

const PhaseSchema = z.enum(LessonPhase).nullable();
const ArtifactKindSchema = z.enum(LessonArtifactKind);
const PendingStatuses = [
  LessonStatus.ADMITTED,
  LessonStatus.DRAFTING,
  LessonStatus.REVIEWING_CONTENT,
  LessonStatus.REPAIRING_CONTENT,
  LessonStatus.RECHECKING_CONTENT,
  LessonStatus.SYNTHESIZING,
  LessonStatus.RENDERING,
  LessonStatus.REVIEWING_VISUALS,
  LessonStatus.REPAIRING_VISUALS,
  LessonStatus.RECHECKING_VISUALS,
];

class PrismaGuidedLessonStore implements GuidedLessonStore {
  constructor(
    private readonly client: Prisma.TransactionClient,
    private readonly transact?: <T>(work: (store: GuidedLessonStore) => Promise<T>) => Promise<T>,
  ) {}

  runAtomically<T>(work: (store: GuidedLessonStore) => Promise<T>): Promise<T> {
    return this.transact ? this.transact(work) : work(this);
  }

  async readAccess(userId: string, classId: string) {
    const row = await this.client.classroomGroup.findUnique({
      where: { id: classId },
      include: {
        teacher: { select: { role: true } },
        enrollments: { where: { studentId: userId, active: true } },
      },
    });
    if (!row || row.deletedAt !== null) {
      return null;
    }
    return {
      classId,
      teacherId: row.teacherId,
      isTeacher: row.teacherId === userId && row.teacher.role === AccountRole.TEACHER,
      enrolled: row.enrollments.length > 0,
      courseRevisionId: row.courseRevisionId,
    };
  }

  async listClasses(userId: string) {
    const rows = await this.client.classroomGroup.findMany({
      where: {
        deletedAt: null,
        OR: [{ teacherId: userId }, { enrollments: { some: { studentId: userId, active: true } } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) =>
      ClassSchema.parse({
        id: row.id,
        teacherId: row.teacherId,
        name: row.name,
        courseRevisionId: row.courseRevisionId,
      }),
    );
  }

  async readPublication(classId: string, courseId: string) {
    const row = await this.client.classroomMaterialPublication.findUnique({ where: { courseId } });
    if (!row) {
      return null;
    }
    const publication = MaterialPublicationSchema.parse(row.document);
    return publication.classId === classId && publication.courseId === courseId
      ? publication
      : null;
  }

  async listLessons(classId: string) {
    const rows = await this.client.guidedLessonRecord.findMany({
      where: { classId },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => LessonRecordSchema.parse(row.document));
  }

  async readLesson(id: string) {
    const row = await this.client.guidedLessonRecord.findUnique({ where: { id } });
    return row ? LessonRecordSchema.parse(row.document) : null;
  }

  async saveLesson(record: LessonRecord, expectedVersion: number) {
    const data = {
      version: record.version,
      status: record.status,
      leaseUntil: record.run?.leaseUntil ? new Date(record.run.leaseUntil) : null,
      document: record,
    };
    if (expectedVersion === 0) {
      await this.client.guidedLessonRecord.create({
        data: { id: record.id, classId: record.classId, ...data },
      });
      return;
    }
    const updated = await this.client.guidedLessonRecord.updateMany({
      where: { id: record.id, version: expectedVersion },
      data,
    });
    if (updated.count !== 1) {
      throw new LessonError(LessonFailure.STALE);
    }
  }

  async saveRevision(record: LessonRecord) {
    await this.client.guidedLessonRevisionRecord.create({
      data: { id: record.revisionId, lessonId: record.id, document: record },
    });
  }

  async readRelease(id: string) {
    const row = await this.client.guidedLessonReleaseRecord.findUnique({ where: { id } });
    return row
      ? LessonReleaseSchema.parse({
          ...LessonReleaseSchema.parse(row.document),
          available: row.available,
        })
      : null;
  }

  async saveRelease(release: LessonRelease) {
    const prior = await this.client.guidedLessonReleaseRecord.findUnique({
      where: { id: release.id },
    });
    if (prior) {
      await this.client.guidedLessonReleaseRecord.update({
        where: { id: release.id },
        data: { available: release.available },
      });
      return;
    }
    await this.client.guidedLessonReleaseRecord.create({
      data: {
        id: release.id,
        lessonId: release.lessonId,
        classId: release.classId,
        available: release.available,
        document: release,
      },
    });
  }

  async listPendingLessons() {
    const rows = await this.client.guidedLessonRecord.findMany({
      where: { status: { in: PendingStatuses } },
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });
    return rows.map((row) => LessonRecordSchema.parse(row.document));
  }

  async withdrawLessonReleases(lessonId: string) {
    await this.client.guidedLessonReleaseRecord.updateMany({
      where: { lessonId, available: true },
      data: { available: false },
    });
  }

  async readBudget(id: string) {
    const row = await this.client.guidedLessonBudgetRecord.findUnique({ where: { id } });
    return row ? LessonBudgetSchema.parse(row.document) : null;
  }

  async saveBudget(budget: LessonBudget, expectedVersion: number) {
    if (expectedVersion === 0) {
      await this.client.guidedLessonBudgetRecord.create({
        data: { id: budget.id, version: budget.version, document: budget },
      });
      return;
    }
    const updated = await this.client.guidedLessonBudgetRecord.updateMany({
      where: { id: budget.id, version: expectedVersion },
      data: { version: budget.version, document: budget },
    });
    if (updated.count !== 1) {
      throw new LessonError(LessonFailure.STALE);
    }
  }

  async readReceipt(userId: string, commandId: string) {
    const row = await this.client.guidedLessonCommandRecord.findUnique({
      where: { userId_commandId: { userId, commandId } },
    });
    return row ? LessonReceiptSchema.parse(row.document) : null;
  }

  async saveReceipt(userId: string, classId: string, commandId: string, receipt: LessonReceipt) {
    await this.client.guidedLessonCommandRecord.create({
      data: { userId, classId, commandId, document: receipt },
    });
  }

  async readProgress(studentId: string, releaseId: string) {
    const row = await this.client.guidedLessonProgressRecord.findUnique({
      where: { studentId_releaseId: { studentId, releaseId } },
    });
    return row ? LessonProgressSchema.parse(row.document) : null;
  }

  async saveProgress(progress: LessonProgress, expectedVersion: number) {
    if (expectedVersion === 0) {
      const prior = await this.client.guidedLessonProgressRecord.findUnique({
        where: {
          studentId_releaseId: { studentId: progress.studentId, releaseId: progress.releaseId },
        },
      });
      if (!prior) {
        await this.client.guidedLessonProgressRecord.create({
          data: {
            studentId: progress.studentId,
            releaseId: progress.releaseId,
            version: progress.version,
            document: progress,
          },
        });
        return;
      }
    }
    const updated = await this.client.guidedLessonProgressRecord.updateMany({
      where: {
        studentId: progress.studentId,
        releaseId: progress.releaseId,
        version: expectedVersion,
      },
      data: { version: progress.version, document: progress },
    });
    if (updated.count !== 1) {
      throw new LessonError(LessonFailure.STALE);
    }
  }

  async listNotes(studentId: string, releaseId: string) {
    const rows = await this.client.guidedLessonNoteRecord.findMany({
      where: { studentId, releaseId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => PrivateNoteSchema.parse(row.document));
  }

  async saveNote(studentId: string, classId: string, note: LessonNote) {
    const prior = await this.client.guidedLessonNoteRecord.findUnique({
      where: { id: note.noteId },
    });
    if (
      prior &&
      (prior.studentId !== studentId ||
        prior.releaseId !== note.anchor.releaseId ||
        prior.version !== note.expectedVersion)
    ) {
      throw new LessonError(LessonFailure.STALE);
    }
    if (!prior && note.expectedVersion !== 0) {
      throw new LessonError(LessonFailure.STALE);
    }
    const saved = { ...note, expectedVersion: note.expectedVersion + 1 };
    await this.client.guidedLessonNoteRecord.upsert({
      where: { id: note.noteId },
      create: {
        id: note.noteId,
        studentId,
        classId,
        releaseId: note.anchor.releaseId,
        version: saved.expectedVersion,
        document: saved,
      },
      update: { version: saved.expectedVersion, document: saved },
    });
  }

  async deleteNote(studentId: string, releaseId: string, noteId: string) {
    await this.client.guidedLessonNoteRecord.deleteMany({
      where: { id: noteId, studentId, releaseId },
    });
  }

  async listRequests(classId: string, studentId: string | null) {
    const rows = await this.client.guidedLessonRequestRecord.findMany({
      where: { classId, ...(studentId ? { studentId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => LessonRequestSchema.parse(row.document));
  }

  async saveRequest(request: LessonRequest) {
    await this.client.guidedLessonRequestRecord.upsert({
      where: { id: request.id },
      create: {
        id: request.id,
        classId: request.classId,
        studentId: request.studentId,
        document: request,
      },
      update: { document: request },
    });
  }

  async saveArtifact(artifact: StoredLessonArtifact) {
    if (
      artifact.bytes.byteLength > 16 * 1024 * 1024 ||
      (await this.readStorageBytes(artifact.classId)) + artifact.bytes.byteLength > 1024 ** 3 ||
      (await this.readRevisionStorageBytes(artifact.lessonId, artifact.revisionId)) +
        artifact.bytes.byteLength >
        160 * 1024 * 1024
    ) {
      throw new LessonError(LessonFailure.BUDGET);
    }
    await this.client.guidedLessonArtifactRecord.create({
      data: {
        id: artifact.artifactId,
        classId: artifact.classId,
        lessonId: artifact.lessonId,
        revisionId: artifact.revisionId,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        digest: artifact.digest,
        sceneId: artifact.sceneId,
        phase: artifact.phase,
        bytes: new Uint8Array(artifact.bytes),
        size: artifact.bytes.byteLength,
      },
    });
  }

  async readArtifact(artifactId: string): Promise<StoredLessonArtifact | null> {
    const row = await this.client.guidedLessonArtifactRecord.findUnique({
      where: { id: artifactId },
    });
    return row
      ? {
          artifactId: row.id,
          classId: row.classId,
          lessonId: row.lessonId,
          revisionId: row.revisionId,
          kind: ArtifactKindSchema.parse(row.kind),
          mimeType: row.mimeType,
          digest: row.digest,
          bytes: new Uint8Array(row.bytes),
          sceneId: row.sceneId,
          phase: PhaseSchema.parse(row.phase),
        }
      : null;
  }

  async readStorageBytes(classId: string) {
    const aggregate = await this.client.guidedLessonArtifactRecord.aggregate({
      where: { classId },
      _sum: { size: true },
    });
    return aggregate._sum.size ?? 0;
  }

  async readRevisionStorageBytes(lessonId: string, revisionId: string) {
    const aggregate = await this.client.guidedLessonArtifactRecord.aggregate({
      where: { lessonId, revisionId },
      _sum: { size: true },
    });
    return aggregate._sum.size ?? 0;
  }

  async deleteExpiredArtifacts(now: Date) {
    const notesBefore = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    await this.client.guidedLessonNoteRecord.deleteMany({
      where: { updatedAt: { lt: notesBefore } },
    });
    // Releases and active approval workflows retain their immutable media.
    const oldLessons = await this.client.guidedLessonRecord.findMany({
      where: {
        status: { in: [LessonStatus.FAILED, LessonStatus.CANCELLED] },
        updatedAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        releases: { none: {} },
      },
      select: { id: true },
      take: 50,
    });
    await this.client.guidedLessonArtifactRecord.deleteMany({
      where: { lessonId: { in: oldLessons.map((item) => item.id) } },
    });
  }
}

export function createPrismaGuidedLessonStore(databaseUrl: string): {
  store: GuidedLessonStore;
  close: () => Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const transact = <T>(work: (store: GuidedLessonStore) => Promise<T>): Promise<T> =>
    runClassroomTransactionWithRetries(
      () =>
        client.$transaction((transaction) => work(new PrismaGuidedLessonStore(transaction)), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      { operation: 'guided-lesson-transaction' },
    );
  return {
    store: new PrismaGuidedLessonStore(client, transact),
    close: () => client.$disconnect(),
  };
}
