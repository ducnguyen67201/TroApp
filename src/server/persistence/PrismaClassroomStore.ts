import { runClassroomTransactionWithRetries } from './RetryClassroomTransaction.js';
import { InsightRecordKind } from '#contracts/ClassroomInsights.js';
import {
  captureClassroomSubmission,
  captureClassroomProgress,
} from './CaptureClassroomLearning.js';
import {
  DisabledLearningCapture,
  type LearningCapturePolicy,
} from './AppendClassroomLearningEvent.js';
import { MaterialDerivationSchema, type MaterialDerivation } from '#contracts/MaterialContext.js';
import {
  StoredMaterialCollectionSchema,
  MaterialPublicationSchema,
  MaterialState,
  type StoredMaterialCollection,
  type MaterialPublication,
} from '#contracts/ClassroomMaterials.js';
import type { MaterialFile } from '../features/materials/application/MaterialPreparation.js';
import { AccountRoleSchema } from '#contracts/AccountRole.js';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/prisma/client.js';
import {
  ClassSchema,
  ClassMeetingSchema,
  CourseRevisionSchema,
  ParticipationSchema,
  StudentAttemptSchema,
  SubmissionPreparationSchema,
  SubmissionReceiptSchema,
  ClassroomFailure,
  ClassroomStatus,
  type CourseContent,
  type ClassMeeting,
  type Participation,
  type StudentAttempt,
  type SubmissionPreparation,
  type SubmissionReceipt,
} from '#contracts/Classroom.js';
import type {
  ClassroomStore,
  StoredClassroomInvitation,
} from '../features/classroom/application/ClassroomStore.js';
import { ClassroomError } from '../features/classroom/domain/ClassroomRules.js';

/** Canonical schema validation contains JSON and generated database types here. */
class PrismaClassroomStore implements ClassroomStore {
  constructor(
    private readonly client: Prisma.TransactionClient,
    private readonly transact?: <T>(operation: (store: ClassroomStore) => Promise<T>) => Promise<T>,
    private readonly capturePolicy: LearningCapturePolicy = DisabledLearningCapture,
  ) {}

  runAtomically<T>(operation: (store: ClassroomStore) => Promise<T>): Promise<T> {
    return this.transact ? this.transact(operation) : operation(this);
  }

  private async invalidateClassroomInsights(classId: string) {
    const retainedState = await this.client.classroomInsightState.findUnique({
      where: { classId },
      select: { classId: true },
    });
    if (!retainedState && !this.capturePolicy.captureClassIds.includes(classId)) {
      return;
    }
    await this.client.classroomInsightState.upsert({
      where: { classId },
      create: { classId, invalidationRevision: 1, revision: 1 },
      update: { invalidationRevision: { increment: 1 }, revision: { increment: 1 } },
    });
  }

  private async isClassroomSourceRemoved(attemptId: string, sourceId: string) {
    const attempt = await this.client.classroomAttempt.findUnique({
      where: { id: attemptId },
      include: { participation: { include: { meeting: true } } },
    });
    if (!attempt) {
      return true;
    }
    const classId = attempt.participation.meeting.classId;
    return Boolean(
      (await this.client.classroomInsightRecord.findFirst({
        where: {
          classId,
          kind: InsightRecordKind.REMOVAL,
          studentId: attempt.participation.studentId,
        },
      })) ||
      (await this.client.classroomExpiredSource.findUnique({
        where: { classId_sourceId: { classId, sourceId } },
      })),
    );
  }

  async readMaterialDerivation(classId: string, key: string) {
    const row = await this.client.classroomMaterialDerivation.findUnique({
      where: { classId_key: { classId, key } },
    });
    return row ? MaterialDerivationSchema.parse(row.document) : null;
  }

  async listMaterialDerivations(jobId: string) {
    const rows = await this.client.classroomMaterialDerivation.findMany({ where: { jobId } });
    return rows.map((row) => MaterialDerivationSchema.parse(row.document));
  }

  async saveMaterialDerivation(record: MaterialDerivation, expectedClaimId: string | null) {
    const document = MaterialDerivationSchema.parse(record);
    const data = { jobId: record.jobId, claimId: record.claimId, document };
    if (expectedClaimId === null) {
      await this.client.classroomMaterialDerivation.create({
        data: { classId: record.classId, key: record.key, ...data },
      });
      return;
    }
    const result = await this.client.classroomMaterialDerivation.updateMany({
      where: { classId: record.classId, key: record.key, claimId: expectedClaimId },
      data,
    });
    if (result.count !== 1) {
      throw new ClassroomError(ClassroomFailure.STALE);
    }
  }

  async readMaterialStorageBytes(classId: string) {
    const files = await this.client.classroomMaterialFile.findMany({
      where: { classId },
      select: { size: true },
    });
    return files.reduce((sum, file) => sum + file.size, 0);
  }

  async reserveMaterialPreparation(userId: string, day: string) {
    for (const [id, limit] of [
      [`user:${userId}:${day}`, 10],
      [`global:${day}`, 100],
    ] as const) {
      await this.client.classroomMaterialBudget.upsert({
        where: { id },
        create: { id, requests: 0 },
        update: {},
      });
      const reservation = await this.client.classroomMaterialBudget.updateMany({
        where: { id, requests: { lt: limit } },
        data: { requests: { increment: 1 } },
      });
      if (reservation.count !== 1) {
        throw new ClassroomError(ClassroomFailure.UNAVAILABLE);
      }
    }
  }

  async readMaterialCollection(classId: string) {
    const row = await this.client.classroomMaterialCollection.findUnique({ where: { classId } });
    return row ? StoredMaterialCollectionSchema.parse(row.document) : null;
  }

  async saveMaterialCollection(collection: StoredMaterialCollection, expectedVersion: number) {
    const data = {
      version: collection.version,
      state: collection.state,
      leaseUntil: collection.leaseUntil ? new Date(collection.leaseUntil) : null,
      document: collection,
    };
    if (expectedVersion === 0) {
      await this.client.classroomMaterialCollection.create({
        data: { classId: collection.classId, ...data },
      });
    } else {
      const updated = await this.client.classroomMaterialCollection.updateMany({
        where: { classId: collection.classId, version: expectedVersion },
        data,
      });
      if (updated.count !== 1) {
        throw new ClassroomError(ClassroomFailure.STALE);
      }
    }
  }

  async listPendingMaterials(now: Date) {
    const rows = await this.client.classroomMaterialCollection.findMany({
      where: {
        schoolClass: { deletedAt: null },
        OR: [
          { state: MaterialState.QUEUED },
          { state: MaterialState.PREPARING, leaseUntil: { lt: now } },
        ],
      },
      take: 10,
    });
    return rows.map((row) => StoredMaterialCollectionSchema.parse(row.document));
  }

  async saveMaterialFile(file: MaterialFile) {
    await this.client.classroomMaterialFile.create({
      data: { ...file, size: file.bytes.length, bytes: Buffer.from(file.bytes) },
    });
  }

  async readMaterialFile(id: string) {
    const row = await this.client.classroomMaterialFile.findUnique({ where: { id } });
    return row
      ? { id: row.id, classId: row.classId, name: row.name, bytes: new Uint8Array(row.bytes) }
      : null;
  }

  async saveMaterialPublication(publication: MaterialPublication) {
    await this.client.classroomMaterialPublication.create({
      data: { courseId: publication.courseId, document: publication },
    });
  }

  async deleteUnpublishedMaterialFile(classId: string, materialId: string): Promise<void> {
    const references = await this.client.classroomMaterialPublication.count({
      where: { document: { path: ['sources'], array_contains: [{ id: materialId }] } },
    });
    if (references === 0) {
      await this.client.classroomMaterialFile.deleteMany({ where: { id: materialId, classId } });
    }
  }

  async readMaterialPublication(courseId: string) {
    const row = await this.client.classroomMaterialPublication.findUnique({ where: { courseId } });
    return row ? MaterialPublicationSchema.parse(row.document) : null;
  }

  async updateClassCourse(classId: string, courseRevisionId: string) {
    if (this.transact) {
      return this.runAtomically((store) => store.updateClassCourse(classId, courseRevisionId));
    }
    await this.client.classroomGroup.update({ where: { id: classId }, data: { courseRevisionId } });
    await this.invalidateClassroomInsights(classId);
  }

  async readAccountRole(userId: string) {
    const user = await this.client.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) {
      throw new ClassroomError(ClassroomFailure.UNAUTHORIZED);
    }
    return AccountRoleSchema.parse(user.role);
  }

  async readVerifiedEmail(userId: string) {
    const user = await this.client.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    });
    return user?.emailVerified ? user.email.toLowerCase() : null;
  }

  async saveInvitation(invitation: StoredClassroomInvitation) {
    await this.client.classroomInvitation.create({
      data: { ...invitation, expiresAt: new Date(invitation.expiresAt) },
    });
  }

  async readInvitation(codeDigest: string): Promise<StoredClassroomInvitation | null> {
    const row = await this.client.classroomInvitation.findUnique({ where: { codeDigest } });
    return row ? { ...row, expiresAt: row.expiresAt.toISOString() } : null;
  }

  async revokeInvitations(classId: string) {
    await this.client.classroomInvitation.updateMany({
      where: { classId },
      data: { revoked: true },
    });
  }

  async listCourses(ownerId: string) {
    const rows = await this.client.classroomCourseRevision.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) =>
      CourseRevisionSchema.parse({
        id: row.id,
        ownerId: row.ownerId,
        title: row.title,
        content: row.content,
      }),
    );
  }

  async saveCourse(ownerId: string, title: string, content: CourseContent) {
    const row = await this.client.classroomCourseRevision.create({
      data: { id: randomUUID(), ownerId, title, content },
    });
    return CourseRevisionSchema.parse({ id: row.id, ownerId, title, content: row.content });
  }

  async readCourse(id: string) {
    const row = await this.client.classroomCourseRevision.findUnique({ where: { id } });
    return row
      ? CourseRevisionSchema.parse({
          id: row.id,
          ownerId: row.ownerId,
          title: row.title,
          content: row.content,
        })
      : null;
  }

  async saveClass(teacherId: string, name: string, courseRevisionId: string) {
    const row = await this.client.classroomGroup.create({
      data: { id: randomUUID(), teacherId, name, courseRevisionId },
    });
    return ClassSchema.parse({ id: row.id, teacherId, name, courseRevisionId });
  }

  async listClasses(userId: string) {
    const rows = await this.client.classroomGroup.findMany({
      where: {
        deletedAt: null,
        OR: [{ teacherId: userId }, { enrollments: { some: { studentId: userId, active: true } } }],
      },
      take: 100,
      orderBy: { createdAt: 'desc' },
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

  async readClass(id: string) {
    const row = await this.client.classroomGroup.findFirst({ where: { id, deletedAt: null } });
    return row
      ? ClassSchema.parse({
          id: row.id,
          teacherId: row.teacherId,
          name: row.name,
          courseRevisionId: row.courseRevisionId,
        })
      : null;
  }

  async deleteClass(classId: string, deletedAt: Date): Promise<void> {
    if (this.transact) {
      return this.runAtomically((store) => store.deleteClass(classId, deletedAt));
    }
    const updated = await this.client.classroomGroup.updateMany({
      where: { id: classId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count !== 1) {
      throw new ClassroomError(ClassroomFailure.STALE);
    }
    await this.invalidateClassroomInsights(classId);
  }

  async readStudentByEmail(email: string) {
    return (
      (
        await this.client.user.findFirst({
          where: { email, emailVerified: true },
          select: { id: true },
        })
      )?.id ?? null
    );
  }

  async enrollStudent(classId: string, studentId: string, active: boolean) {
    if (this.transact) {
      return this.runAtomically((store) => store.enrollStudent(classId, studentId, active));
    }
    if (
      active &&
      (await this.client.classroomEnrollment.count({ where: { classId, active: true } })) >= 200 &&
      !(await this.isEnrolled(classId, studentId))
    ) {
      throw new ClassroomError(ClassroomFailure.INVALID);
    }
    await this.client.classroomEnrollment.upsert({
      where: { classId_studentId: { classId, studentId } },
      create: { classId, studentId, active },
      update: { active },
    });
    await this.invalidateClassroomInsights(classId);
  }

  async isEnrolled(classId: string, studentId: string) {
    return (
      (
        await this.client.classroomEnrollment.findUnique({
          where: { classId_studentId: { classId, studentId } },
        })
      )?.active ?? false
    );
  }

  async listMeetings(classId: string) {
    return (
      await this.client.classroomMeeting.findMany({
        where: { classId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
    ).map((row) =>
      ClassMeetingSchema.parse({
        id: row.id,
        classId,
        status: row.status,
        phase: row.phase,
        pacing: row.pacing,
        currentActivityId: row.currentActivityId,
        contextVersion: row.contextVersion,
      }),
    );
  }

  async readMeeting(id: string) {
    const row = await this.client.classroomMeeting.findUnique({ where: { id } });
    return row
      ? ClassMeetingSchema.parse({
          id,
          classId: row.classId,
          status: row.status,
          phase: row.phase,
          pacing: row.pacing,
          currentActivityId: row.currentActivityId,
          contextVersion: row.contextVersion,
        })
      : null;
  }

  async saveMeeting(meeting: ClassMeeting) {
    await this.client.classroomMeeting.upsert({
      where: { id: meeting.id },
      create: meeting,
      update: meeting,
    });
  }

  async joinMeeting(classSessionId: string, studentId: string, deviceId: string, leaseUntil: Date) {
    const row = await this.client.classroomParticipation.upsert({
      where: { classSessionId_studentId: { classSessionId, studentId } },
      create: { id: randomUUID(), classSessionId, studentId, deviceId, leaseUntil },
      update: { deviceId, leaseUntil, left: false },
    });
    return ParticipationSchema.parse({
      id: row.id,
      classSessionId,
      studentId,
      deviceId,
      leaseUntil: row.leaseUntil.toISOString(),
      left: row.left,
    });
  }

  async listJoinedParticipations(studentId: string) {
    const rows = await this.client.classroomParticipation.findMany({
      where: { studentId, left: false, meeting: { status: ClassroomStatus.LIVE } },
      orderBy: { leaseUntil: 'desc' },
      take: 100,
    });
    return rows.map((row) =>
      ParticipationSchema.parse({ ...row, leaseUntil: row.leaseUntil.toISOString() }),
    );
  }

  async readParticipation(id: string) {
    const row = await this.client.classroomParticipation.findUnique({ where: { id } });
    return row
      ? ParticipationSchema.parse({ ...row, leaseUntil: row.leaseUntil.toISOString() })
      : null;
  }

  async saveParticipation(participation: Participation) {
    await this.client.classroomParticipation.update({
      where: { id: participation.id },
      data: {
        deviceId: participation.deviceId,
        leaseUntil: new Date(participation.leaseUntil),
        left: participation.left,
      },
    });
  }

  async readOrCreateAttempt(participationId: string, activityId: string) {
    const row = await this.client.classroomAttempt.upsert({
      where: { participationId_activityId: { participationId, activityId } },
      create: { id: randomUUID(), participationId, activityId, evidence: [] },
      update: {},
    });
    return StudentAttemptSchema.parse({
      id: row.id,
      participationId: row.participationId,
      activityId: row.activityId,
      progressVersion: row.progressVersion,
      workspaceUrl: row.workspaceUrl,
      evidence: row.evidence,
      declaredComplete: row.declaredComplete,
      helpSummary: row.helpSummary,
    });
  }

  async saveAttempt(attempt: StudentAttempt) {
    await this.client.classroomAttempt.update({
      where: { id: attempt.id },
      data: {
        lastSavedAt: new Date(),
        progressVersion: attempt.progressVersion,
        workspaceUrl: attempt.workspaceUrl,
        evidence: attempt.evidence,
        declaredComplete: attempt.declaredComplete,
        helpSummary: attempt.helpSummary,
      },
    });
  }

  async hasProgressEvent(attemptId: string, eventId: string) {
    return Boolean(
      await this.client.classroomProgressEvent.findUnique({
        where: { attemptId_eventId: { attemptId, eventId } },
      }),
    );
  }

  async saveProgressEvent(attemptId: string, eventId: string) {
    if (this.transact && this.capturePolicy.captureClassIds.length) {
      return this.runAtomically((store) => store.saveProgressEvent(attemptId, eventId));
    }
    await this.client.classroomProgressEvent.create({ data: { attemptId, eventId } });
    await captureClassroomProgress(this.client, this.capturePolicy, attemptId, eventId);
  }

  async savePreparation(preparation: SubmissionPreparation) {
    await this.client.classroomSubmissionPreparation.create({
      data: { ...preparation, expiresAt: new Date(preparation.expiresAt) },
    });
  }

  async readPreparation(id: string) {
    const row = await this.client.classroomSubmissionPreparation.findUnique({ where: { id } });
    return row
      ? SubmissionPreparationSchema.parse({ ...row, expiresAt: row.expiresAt.toISOString() })
      : null;
  }

  async readSubmission(attemptId: string, idempotencyKey: string) {
    const row = await this.client.classroomSubmission.findUnique({
      where: { attemptId_idempotencyKey: { attemptId, idempotencyKey } },
    });
    return row && !(await this.isClassroomSourceRemoved(attemptId, row.id))
      ? SubmissionReceiptSchema.parse({
          id: row.id,
          attemptId,
          url: row.url,
          submittedAt: row.submittedAt.toISOString(),
        })
      : null;
  }

  async readLatestSubmission(attemptId: string) {
    const row = await this.client.classroomSubmission.findFirst({
      where: { attemptId },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    });
    return row && !(await this.isClassroomSourceRemoved(attemptId, row.id))
      ? SubmissionReceiptSchema.parse({
          id: row.id,
          attemptId,
          url: row.url,
          submittedAt: row.submittedAt.toISOString(),
        })
      : null;
  }

  async saveSubmission(receipt: SubmissionReceipt, idempotencyKey: string) {
    if (this.transact && this.capturePolicy.captureClassIds.length) {
      return this.runAtomically((store) => store.saveSubmission(receipt, idempotencyKey));
    }
    await this.client.classroomSubmission.create({
      data: { ...receipt, idempotencyKey, submittedAt: new Date(receipt.submittedAt) },
    });
    await captureClassroomSubmission(
      this.client,
      this.capturePolicy,
      receipt.id,
      receipt.attemptId,
      new Date(receipt.submittedAt),
      null,
      null,
      null,
    );
  }

  async readRoster(classSessionId: string, classId: string) {
    const rows = await this.client.classroomEnrollment.findMany({
      where: { classId, active: true },
      include: {
        student: {
          select: {
            id: true,
            name: true,
            classParticipations: {
              where: { classSessionId },
              include: {
                attempts: {
                  include: { submissions: { take: 100, orderBy: { submittedAt: 'desc' } } },
                },
              },
            },
          },
        },
      },
      take: 200,
    });
    return rows.map(({ student }) => {
      const participation = student.classParticipations[0];
      return {
        studentId: student.id,
        name: student.name,
        participation: participation
          ? ParticipationSchema.parse({
              id: participation.id,
              classSessionId,
              studentId: student.id,
              deviceId: participation.deviceId,
              leaseUntil: participation.leaseUntil.toISOString(),
              left: participation.left,
            })
          : null,
        attempts:
          participation?.attempts.map((attempt) =>
            StudentAttemptSchema.parse({
              id: attempt.id,
              participationId: attempt.participationId,
              activityId: attempt.activityId,
              progressVersion: attempt.progressVersion,
              workspaceUrl: attempt.workspaceUrl,
              evidence: attempt.evidence,
              declaredComplete: attempt.declaredComplete,
              helpSummary: attempt.helpSummary,
            }),
          ) ?? [],
        submissions:
          participation?.attempts
            .flatMap((attempt) =>
              attempt.submissions.map((submission) =>
                SubmissionReceiptSchema.parse({
                  id: submission.id,
                  attemptId: attempt.id,
                  url: submission.url,
                  submittedAt: submission.submittedAt.toISOString(),
                }),
              ),
            )
            .slice(0, 100) ?? [],
      };
    });
  }
}

export function createPrismaClassroomStore(
  connectionString: string,
  capturePolicy: LearningCapturePolicy = DisabledLearningCapture,
): {
  store: ClassroomStore;
  close(): Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const transact = <T>(operation: (store: ClassroomStore) => Promise<T>): Promise<T> =>
    runClassroomTransactionWithRetries(
      () =>
        client.$transaction(
          (transaction) =>
            operation(new PrismaClassroomStore(transaction, undefined, capturePolicy)),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      { operation: 'classroom-write' },
      { createExhaustionError: () => new ClassroomError(ClassroomFailure.STALE) },
    );
  return {
    store: new PrismaClassroomStore(client, transact, capturePolicy),
    close: () => client.$disconnect(),
  };
}
