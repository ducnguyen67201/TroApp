import { createHash, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { AuthUserSchema } from '#contracts/AuthSession.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import { StudentDeviceContextSchema } from '#contracts/StudentAccess.js';
import { ClassroomStatus } from '#contracts/Classroom.js';
import {
  StudentAccessError,
  StudentAccessPolicy,
  type StudentAccessStore,
  type StudentPrincipal,
} from '../features/studentAccess/application/StudentAccessStore.js';

type Client = Prisma.TransactionClient;

async function assertClassOwner(client: Client, teacherId: string, classId: string): Promise<void> {
  const schoolClass = await client.classroomGroup.findFirst({
    where: {
      id: classId,
      teacherId,
      deletedAt: null,
      teacher: { role: 'teacher', emailVerified: true },
    },
  });
  if (!schoolClass) {
    throw new StudentAccessError();
  }
}

async function readDeviceContext(
  client: Client,
  device: {
    schoolId: string;
    classId: string;
    mode: string;
    expiresAt: Date;
    revoked: boolean;
    admissionId: string;
  },
  now: Date,
) {
  const [school, schoolClass, admission] = await Promise.all([
    client.studentSchool.findUnique({ where: { id: device.schoolId } }),
    client.classroomGroup.findFirst({
      where: {
        id: device.classId,
        deletedAt: null,
        teacher: { role: 'teacher', emailVerified: true },
      },
    }),
    client.studentAdmission.findUnique({ where: { id: device.admissionId } }),
  ]);
  if (
    !school ||
    !schoolClass ||
    !admission ||
    admission.revoked ||
    device.revoked ||
    device.expiresAt <= now ||
    school.ownerId !== schoolClass.teacherId
  ) {
    throw new StudentAccessError();
  }
  return StudentDeviceContextSchema.parse({
    schoolId: school.id,
    schoolName: school.name,
    classId: schoolClass.id,
    className: schoolClass.name,
    mode: device.mode,
    expiresAt: device.expiresAt.toISOString(),
  });
}

async function readPrincipal(
  client: Client,
  sessionId: string,
  now: Date,
): Promise<StudentPrincipal | null> {
  const session = await client.studentLearnerSession.findUnique({ where: { id: sessionId } });
  if (!session || session.revoked || session.expiresAt <= now) {
    return null;
  }
  const device = await client.studentDevice.findUnique({ where: { id: session.deviceId } });
  const profile = await client.studentLearnerProfile.findUnique({
    where: { userId: session.userId },
    include: { user: true },
  });
  if (!device || !profile || device.schoolId !== profile.schoolId) {
    return null;
  }
  let context;
  try {
    context = await readDeviceContext(client, device, now);
  } catch (error) {
    if (error instanceof StudentAccessError) {
      return null;
    }
    throw error;
  }
  if (context.mode === StudentDeviceMode.SHARED) {
    const meeting = session.meetingId
      ? await client.classroomMeeting.findUnique({ where: { id: session.meetingId } })
      : null;
    if (
      !meeting ||
      meeting.status !== ClassroomStatus.LIVE ||
      meeting.classId !== context.classId
    ) {
      return null;
    }
  }
  const enrollment = await client.classroomEnrollment.findUnique({
    where: { classId_studentId: { classId: context.classId, studentId: profile.userId } },
  });
  const otherEnrollment = await client.classroomEnrollment.findFirst({
    where: { studentId: profile.userId, active: true, classId: { not: context.classId } },
  });
  if (
    !enrollment?.active ||
    otherEnrollment ||
    profile.user.role !== 'student' ||
    profile.user.isAdmin ||
    profile.user.email !== null
  ) {
    return null;
  }
  return {
    sessionId: session.id,
    deviceId: device.id,
    schoolId: context.schoolId,
    classId: context.classId,
    mode: context.mode,
    meetingId: session.meetingId,
    expiresAt: session.expiresAt,
    user: AuthUserSchema.parse({
      id: profile.userId,
      name: profile.user.name,
      email: null,
      isAdmin: false,
      learner: {
        schoolId: context.schoolId,
        schoolName: context.schoolName,
        classId: context.classId,
        externalId: profile.externalId,
        mode: context.mode,
        provisional: true,
      },
    }),
  };
}

async function reserveCounter(client: Client, id: string, limit: number): Promise<void> {
  await client.studentAccessUsage.upsert({ where: { id }, create: { id, count: 0 }, update: {} });
  const updated = await client.studentAccessUsage.updateMany({
    where: { id, count: { lt: limit } },
    data: { count: { increment: 1 } },
  });
  if (updated.count !== 1) {
    throw new StudentAccessError(
      'The class has reached its usage allowance. Please ask your teacher.',
    );
  }
}

/** Dedicated learner sessions share canonical users, never Better Auth's email-based OAuth identities. */
export function createPrismaStudentAccessStore(databaseUrl: string): {
  store: StudentAccessStore;
  close: () => Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  async function transact<Result>(
    operation: (transaction: Client) => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2034', 'P2002'].includes(error.code) ||
          attempt === 3
        ) {
          throw error;
        }
      }
    }
    throw new StudentAccessError();
  }

  async function audit(
    transaction: Client,
    schoolId: string,
    actorId: string,
    operation: string,
  ): Promise<void> {
    await transaction.studentAccessAudit.create({
      data: { id: randomUUID(), schoolId, actorId, operation },
    });
  }

  const store: StudentAccessStore = {
    async createAdmission(teacherId, command, digest, now) {
      await transact(async (transaction) => {
        await assertClassOwner(transaction, teacherId, command.classId);
        const school = await transaction.studentSchool.upsert({
          where: { ownerId: teacherId },
          create: { id: randomUUID(), ownerId: teacherId, name: command.schoolName },
          update: { name: command.schoolName },
        });
        await transaction.studentAdmission.create({
          data: {
            id: randomUUID(),
            schoolId: school.id,
            classId: command.classId,
            codeDigest: digest,
            mode: command.mode,
            expiresAt: new Date(now.getTime() + StudentAccessPolicy.ACTIVATION_MS),
          },
        });
        await audit(transaction, school.id, teacherId, 'create-admission');
      });
    },
    async activateDevice(codeDigest, requestId, credential, now) {
      return transact(async (transaction) => {
        const admission = await transaction.studentAdmission.findUnique({ where: { codeDigest } });
        if (!admission || admission.revoked || admission.expiresAt <= now) {
          throw new StudentAccessError();
        }
        let device = await transaction.studentDevice.findUnique({ where: { requestId } });
        if (
          device &&
          (device.admissionId !== admission.id || device.credentialDigest !== credential.digest)
        ) {
          throw new StudentAccessError();
        }
        if (!device) {
          const limit =
            admission.mode === StudentDeviceMode.SHARED
              ? 1
              : StudentAccessPolicy.PERSONAL_DEVICES_PER_CODE;
          const consumed = await transaction.studentAdmission.updateMany({
            where: { id: admission.id, revoked: false, uses: { lt: limit } },
            data: { uses: { increment: 1 } },
          });
          if (consumed.count !== 1) {
            throw new StudentAccessError();
          }
          device = await transaction.studentDevice.create({
            data: {
              id: randomUUID(),
              requestId,
              admissionId: admission.id,
              schoolId: admission.schoolId,
              classId: admission.classId,
              credentialDigest: credential.digest,
              mode: admission.mode,
              expiresAt: new Date(now.getTime() + StudentAccessPolicy.DEVICE_MS),
            },
          });
          await audit(transaction, admission.schoolId, device.id, 'activate-device');
        }
        return { kind: 'ready', context: await readDeviceContext(transaction, device, now) };
      });
    },
    async readDevice(digest, now) {
      const device = await client.studentDevice.findUnique({ where: { credentialDigest: digest } });
      if (!device) {
        throw new StudentAccessError();
      }
      return { kind: 'ready', context: await readDeviceContext(client, device, now) };
    },
    async enroll(digest, command, payloadDigest, credential, now) {
      return transact(async (transaction) => {
        const device = await transaction.studentDevice.findUnique({
          where: { credentialDigest: digest },
        });
        if (!device) {
          throw new StudentAccessError();
        }
        const context = await readDeviceContext(transaction, device, now);
        let session = await transaction.studentLearnerSession.findUnique({
          where: { deviceId_requestId: { deviceId: device.id, requestId: command.requestId } },
        });
        if (
          session &&
          (session.payloadDigest !== payloadDigest || session.revoked || session.expiresAt <= now)
        ) {
          throw new StudentAccessError('This sign-in attempt has ended. Start a new attempt.');
        }
        if (session) {
          session = await transaction.studentLearnerSession.update({
            where: { id: session.id },
            data: { credentialDigest: credential.digest },
          });
        } else {
          const count = await transaction.studentLearnerSession.count({
            where: { deviceId: device.id },
          });
          if (count >= StudentAccessPolicy.PROFILES_PER_DEVICE) {
            throw new StudentAccessError();
          }
          const meeting =
            context.mode === StudentDeviceMode.SHARED
              ? await transaction.classroomMeeting.findFirst({
                  where: { classId: context.classId, status: ClassroomStatus.LIVE },
                  orderBy: { createdAt: 'desc' },
                })
              : null;
          if (context.mode === StudentDeviceMode.SHARED && !meeting) {
            throw new StudentAccessError(
              'Your teacher needs to start the class before you can join.',
            );
          }
          await reserveCounter(
            transaction,
            `admission:${context.schoolId}:${now.toISOString().slice(0, 10)}`,
            StudentAccessPolicy.DAILY_SCHOOL_ADMISSIONS,
          );
          const userId = randomUUID();
          await transaction.user.create({
            data: {
              id: userId,
              name: command.name,
              email: null,
              role: 'student',
              emailVerified: false,
              learnerProfile: {
                create: { schoolId: context.schoolId, externalId: command.externalId },
              },
            },
          });
          await transaction.classroomEnrollment.create({
            data: { classId: context.classId, studentId: userId },
          });
          session = await transaction.studentLearnerSession.create({
            data: {
              id: randomUUID(),
              userId,
              deviceId: device.id,
              requestId: command.requestId,
              payloadDigest,
              credentialDigest: credential.digest,
              meetingId: meeting?.id ?? null,
              expiresAt: new Date(
                now.getTime() +
                  (context.mode === StudentDeviceMode.SHARED
                    ? StudentAccessPolicy.SHARED_SESSION_MS
                    : StudentAccessPolicy.PERSONAL_SESSION_MS),
              ),
            },
          });
          await audit(transaction, context.schoolId, userId, 'create-provisional-learner');
        }
        const principal = await readPrincipal(transaction, session.id, now);
        if (!principal) {
          throw new StudentAccessError();
        }
        return principal;
      });
    },
    async readSession(digest, now) {
      const session = await client.studentLearnerSession.findUnique({
        where: { credentialDigest: digest },
      });
      return session ? readPrincipal(client, session.id, now) : null;
    },
    readSessionById: (sessionId, now) => readPrincipal(client, sessionId, now),
    async refreshSession(digest, now) {
      return transact(async (transaction) => {
        const session = await transaction.studentLearnerSession.findUnique({
          where: { credentialDigest: digest },
        });
        const principal = session ? await readPrincipal(transaction, session.id, now) : null;
        if (!principal || principal.mode === StudentDeviceMode.SHARED) {
          return principal;
        }
        const device = await transaction.studentDevice.findUnique({
          where: { id: principal.deviceId },
        });
        if (!device) {
          return null;
        }
        const expiresAt = new Date(
          Math.min(
            now.getTime() + StudentAccessPolicy.PERSONAL_SESSION_MS,
            device.expiresAt.getTime(),
          ),
        );
        await transaction.studentLearnerSession.update({
          where: { id: principal.sessionId },
          data: { expiresAt },
        });
        return { ...principal, expiresAt };
      });
    },
    async revokeSession(digest) {
      await transact(async (transaction) => {
        const session = await transaction.studentLearnerSession.findUnique({
          where: { credentialDigest: digest },
        });
        if (!session || session.revoked) {
          return;
        }
        const profile = await transaction.studentLearnerProfile.findUnique({
          where: { userId: session.userId },
        });
        await transaction.studentLearnerSession.update({
          where: { id: session.id },
          data: { revoked: true },
        });
        if (profile) {
          await audit(transaction, profile.schoolId, session.userId, 'revoke-session');
        }
      });
    },
    async revokeAdmissions(teacherId, classId) {
      await transact(async (transaction) => {
        await assertClassOwner(transaction, teacherId, classId);
        await transaction.studentAdmission.updateMany({
          where: { classId },
          data: { revoked: true },
        });
        await transaction.studentDevice.updateMany({ where: { classId }, data: { revoked: true } });
        const school = await transaction.studentSchool.findUnique({
          where: { ownerId: teacherId },
        });
        if (school) {
          await audit(transaction, school.id, teacherId, 'revoke-class-access');
        }
      });
    },
    async reserveModelRequest(sessionId, now) {
      try {
        return await transact(async (transaction) => {
          const principal = await readPrincipal(transaction, sessionId, now);
          if (!principal) {
            return false;
          }
          const day = now.toISOString().slice(0, 10);
          await reserveCounter(
            transaction,
            `model-school:${principal.schoolId}:${day}`,
            StudentAccessPolicy.DAILY_SCHOOL_MODEL_REQUESTS,
          );
          await reserveCounter(
            transaction,
            `model-user:${principal.user.id}:${day}`,
            StudentAccessPolicy.DAILY_LEARNER_MODEL_REQUESTS,
          );
          return true;
        });
      } catch (error) {
        if (error instanceof StudentAccessError) {
          return false;
        }
        throw error;
      }
    },
    async canAccessClassroom(principal, command) {
      if (command.kind === 'home' || command.kind === 'resume') {
        return true;
      }
      if (command.kind === 'join') {
        const meeting = await client.classroomMeeting.findUnique({
          where: { id: command.classSessionId },
        });
        return (
          meeting?.classId === principal.classId &&
          (!principal.meetingId || principal.meetingId === meeting.id)
        );
      }
      if ('participationId' in command) {
        const participation = await client.classroomParticipation.findUnique({
          where: { id: command.participationId },
          include: { meeting: true },
        });
        return (
          participation?.studentId === principal.user.id &&
          participation.meeting.classId === principal.classId &&
          (!principal.meetingId || participation.meeting.id === principal.meetingId)
        );
      }
      return false;
    },
    async reviewRoster(teacherId, command) {
      return transact(async (transaction) => {
        await assertClassOwner(transaction, teacherId, command.classId);
        const school = await transaction.studentSchool.findUnique({
          where: { ownerId: teacherId },
        });
        if (!school) {
          throw new StudentAccessError();
        }
        const identifiers = command.rows.map((row) => row.externalId);
        if (new Set(identifiers).size !== identifiers.length) {
          throw new StudentAccessError('The roster contains duplicate student IDs.');
        }
        const claims = await transaction.studentLearnerProfile.findMany({
          where: { schoolId: school.id, source: 'school-card', externalId: { in: identifiers } },
        });
        const conflicts = identifiers.filter(
          (id) => claims.filter((claim) => claim.externalId === id).length > 1,
        );
        const matched = identifiers.filter((id) =>
          claims.some((claim) => claim.externalId === id),
        ).length;
        if (command.kind === 'apply-roster') {
          const payloadDigest = createHash('sha256')
            .update(JSON.stringify(command.rows))
            .digest('hex');
          const previous = await transaction.studentRosterBatch.findUnique({
            where: {
              schoolId_revision_payloadDigest: {
                schoolId: school.id,
                revision: command.revision,
                payloadDigest,
              },
            },
          });
          if (previous) {
            return { kind: 'done' };
          }
          if (command.revision !== school.rosterRevision || conflicts.length) {
            throw new StudentAccessError(
              'The roster changed or contains competing claims. Review it again.',
            );
          }
          for (const row of command.rows) {
            await transaction.studentRosterRecord.upsert({
              where: {
                schoolId_source_externalId: {
                  schoolId: school.id,
                  source: 'school-card',
                  externalId: row.externalId,
                },
              },
              create: { schoolId: school.id, externalId: row.externalId, name: row.name },
              update: { name: row.name },
            });
            await transaction.studentLearnerProfile.updateMany({
              where: { schoolId: school.id, source: 'school-card', externalId: row.externalId },
              data: { rosterName: row.name },
            });
          }
          await transaction.studentSchool.update({
            where: { id: school.id },
            data: { rosterRevision: { increment: 1 } },
          });
          await transaction.studentRosterBatch.create({
            data: { schoolId: school.id, revision: command.revision, payloadDigest },
          });
          await audit(transaction, school.id, teacherId, 'associate-roster-metadata');
          return { kind: 'done' };
        }
        return {
          kind: 'roster-preview',
          revision: school.rosterRevision,
          matched,
          missing: command.rows.length - matched,
          conflicts,
        };
      });
    },
  };
  return { store, close: () => client.$disconnect() };
}
