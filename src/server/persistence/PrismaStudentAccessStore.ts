import { randomUUID } from 'node:crypto';
import { setTimeout as waitForRetry } from 'node:timers/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { AuthUserSchema } from '#contracts/AuthSession.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import {
  OrganizationComputerLimits,
  StudentDeviceContextSchema,
  type StudentEnrollment,
} from '#contracts/StudentAccess.js';
import {
  findOrCreateOrganizationStudent,
  readOrganizationComputerUsage,
  requireOrganizationComputerAdmin,
  requireComputerCodeIssuer,
} from './OrganizationComputerAccess.js';
import { ClassroomStatus } from '#contracts/Classroom.js';
import { readClassroomTransactionConflict } from './RetryClassroomTransaction.js';
import {
  StudentAccessError,
  StudentAccessPolicy,
  type StudentAccessStore,
  type StudentPrincipal,
} from '../features/studentAccess/application/StudentAccessStore.js';

type Client = Prisma.TransactionClient;

const StudentSignInAuditEvent = {
  CREATE_LEARNER: 'create-provisional-learner',
  SIGN_IN: 'sign-in-existing-learner',
} as const;

const StudentAccessTransactionRetry = { MAX_ATTEMPTS: 4, BASE_DELAY_MS: 10 } as const;

const StudentComputerAuditEvent = {
  CREATE_CODE: 'create-computer-code',
  REVOKE_CODE: 'revoke-computer-code',
  REVOKE_COMPUTER: 'revoke-computer',
  DEACTIVATE: 'deactivate-computer',
} as const;

/** Serializable organization reads keep automatic names distinct, including concurrent activations. */
async function generateComputerName(client: Client, organizationId: string): Promise<string> {
  const computers = await client.studentDevice.findMany({
    where: { organizationId },
    select: { computerName: true },
    take: OrganizationComputerLimits.COMPUTERS,
  });
  if (computers.length >= OrganizationComputerLimits.COMPUTERS) {
    throw new StudentAccessError('The organization has reached its computer allowance.');
  }
  const names = new Set(computers.map((computer) => computer.computerName));
  let number = computers.length + 1;
  while (names.has(`Computer ${String(number)}`)) {
    number += 1;
  }
  return `Computer ${String(number)}`;
}

async function readDeviceContext(
  client: Client,
  device: {
    schoolId: string;
    classId: string | null;
    organizationId: string | null;
    mode: string;
    expiresAt: Date;
    revoked: boolean;
    admissionId: string;
  },
  now: Date,
) {
  const admission = await client.studentAdmission.findUnique({ where: { id: device.admissionId } });
  if (
    !admission ||
    (device.organizationId === null && admission.revoked) ||
    device.revoked ||
    device.expiresAt <= now ||
    admission.schoolId !== device.schoolId ||
    admission.classId !== device.classId ||
    admission.organizationId !== device.organizationId ||
    (device.organizationId === null && admission.mode !== device.mode)
  ) {
    throw new StudentAccessError();
  }
  if (device.organizationId !== null) {
    const organization = await client.organization.findUnique({
      where: { id: device.organizationId },
    });
    if (
      !organization ||
      organization.nameSetAt === null ||
      device.classId !== null ||
      device.schoolId !== organization.id
    ) {
      throw new StudentAccessError();
    }
    return StudentDeviceContextSchema.parse({
      schoolId: organization.id,
      schoolName: organization.name,
      organizationId: organization.id,
      classId: null,
      className: null,
      mode: device.mode,
      expiresAt: device.expiresAt.toISOString(),
    });
  }
  if (device.classId === null) {
    throw new StudentAccessError();
  }
  const [school, schoolClass] = await Promise.all([
    client.studentSchool.findUnique({ where: { id: device.schoolId } }),
    client.classroomGroup.findFirst({
      where: {
        id: device.classId,
        organizationId: null,
        deletedAt: null,
        teacher: { role: 'teacher', emailVerified: true },
      },
    }),
  ]);
  if (!school || !schoolClass || school.ownerId !== schoolClass.teacherId) {
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
  if (context.mode === StudentDeviceMode.SHARED && !context.organizationId) {
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
  let hasAccess: boolean;
  if (context.organizationId) {
    const membership = await client.organizationMembership.findUnique({
      where: {
        organizationId_userId: { organizationId: context.organizationId, userId: profile.userId },
      },
    });
    hasAccess =
      profile.organizationId === context.organizationId &&
      membership !== null &&
      membership.removedAt === null &&
      membership.role === 'student';
  } else {
    if (context.classId === null || profile.organizationId !== null) {
      return null;
    }
    const enrollment = await client.classroomEnrollment.findUnique({
      where: { classId_studentId: { classId: context.classId, studentId: profile.userId } },
    });
    const otherEnrollment = await client.classroomEnrollment.findFirst({
      where: { studentId: profile.userId, active: true, classId: { not: context.classId } },
    });
    hasAccess = Boolean(enrollment?.active) && !otherEnrollment;
  }
  if (
    !hasAccess ||
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
    ...(context.organizationId ? { organizationId: context.organizationId } : {}),
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
        ...(context.organizationId ? { organizationId: context.organizationId } : {}),
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

/** QR login is limited to the configured class, including its existing enrollment revocations. */
async function findOrCreateStudentForQrSignIn(
  client: Client,
  schoolId: string,
  classId: string,
  command: StudentEnrollment,
): Promise<{ userId: string; created: boolean }> {
  const profiles = await client.studentLearnerProfile.findMany({
    where: {
      schoolId,
      organizationId: null,
      source: 'school-card',
      externalId: command.externalId,
      user: { classEnrollments: { some: { classId } } },
    },
    take: 2,
  });
  if (profiles.length > 1) {
    throw new StudentAccessError(
      'This student ID is linked to multiple accounts. Ask your teacher for help.',
    );
  }
  const profile = profiles[0];
  if (profile) {
    return { userId: profile.userId, created: false };
  }
  if (!command.name) {
    throw new StudentAccessError('Enter your name for your first sign-in.');
  }
  const userId = randomUUID();
  await client.user.create({
    data: {
      id: userId,
      name: command.name,
      email: null,
      role: 'student',
      emailVerified: false,
      learnerProfile: { create: { schoolId, externalId: command.externalId } },
    },
  });
  await client.classroomEnrollment.create({ data: { classId, studentId: userId } });
  return { userId, created: true };
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
    for (let attempt = 1; attempt <= StudentAccessTransactionRetry.MAX_ATTEMPTS; attempt += 1) {
      try {
        return await client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const reason = readClassroomTransactionConflict(error);
        if (reason === null) {
          throw error;
        }
        if (attempt === StudentAccessTransactionRetry.MAX_ATTEMPTS) {
          console.warn('student.access.transaction.failed', {
            stage: 'transaction-retry-exhausted',
            reason,
            attempts: attempt,
          });
          throw error;
        }
        await waitForRetry(StudentAccessTransactionRetry.BASE_DELAY_MS * attempt);
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
    async createComputerCode(actorId, command, digest, now) {
      await transact(async (transaction) => {
        await requireOrganizationComputerAdmin(transaction, actorId, command.organizationId);
        const computers = await transaction.studentDevice.count({
          where: { organizationId: command.organizationId },
        });
        const codes = await transaction.studentAdmission.count({
          where: {
            organizationId: command.organizationId,
            revoked: false,
            expiresAt: { gt: now },
          },
        });
        if (
          computers >= OrganizationComputerLimits.COMPUTERS ||
          codes >= OrganizationComputerLimits.ACTIVE_CODES
        ) {
          throw new StudentAccessError('The organization has reached its computer allowance.');
        }
        await transaction.studentAdmission.create({
          data: {
            id: randomUUID(),
            schoolId: command.organizationId,
            organizationId: command.organizationId,
            issuedById: actorId,
            codeDigest: digest,
            mode: StudentDeviceMode.SHARED,
            expiresAt: new Date(now.getTime() + StudentAccessPolicy.ACTIVATION_MS),
          },
        });
        await audit(
          transaction,
          command.organizationId,
          actorId,
          StudentComputerAuditEvent.CREATE_CODE,
        );
      });
    },
    readOrganizationAccess(actorId, organizationId, now) {
      return transact((transaction) =>
        readOrganizationComputerUsage(transaction, actorId, organizationId, now),
      );
    },
    async revokeComputer(actorId, organizationId, deviceId, now) {
      await transact(async (transaction) => {
        await requireOrganizationComputerAdmin(transaction, actorId, organizationId);
        const changed = await transaction.studentDevice.updateMany({
          where: { id: deviceId, organizationId },
          data: { revoked: true },
        });
        if (changed.count !== 1) {
          throw new StudentAccessError();
        }
        await transaction.studentLearnerSession.updateMany({
          where: { deviceId },
          data: { revoked: true, expiresAt: now },
        });
        await audit(
          transaction,
          organizationId,
          actorId,
          StudentComputerAuditEvent.REVOKE_COMPUTER,
        );
      });
    },
    async revokeComputerCode(actorId, organizationId, admissionId) {
      await transact(async (transaction) => {
        await requireOrganizationComputerAdmin(transaction, actorId, organizationId);
        const changed = await transaction.studentAdmission.updateMany({
          where: { id: admissionId, organizationId },
          data: { revoked: true },
        });
        if (changed.count !== 1) {
          throw new StudentAccessError();
        }
        await audit(transaction, organizationId, actorId, StudentComputerAuditEvent.REVOKE_CODE);
      });
    },
    async deactivateDevice(digest) {
      await transact(async (transaction) => {
        const device = await transaction.studentDevice.findUnique({
          where: { credentialDigest: digest },
        });
        if (!device) {
          throw new StudentAccessError();
        }
        await transaction.studentDevice.update({
          where: { id: device.id },
          data: { revoked: true },
        });
        await transaction.studentLearnerSession.updateMany({
          where: { deviceId: device.id },
          data: { revoked: true },
        });
        await audit(transaction, device.schoolId, device.id, StudentComputerAuditEvent.DEACTIVATE);
      });
    },
    async activateDevice(codeDigest, requestId, credential, now, mode = StudentDeviceMode.SHARED) {
      return transact(async (transaction) => {
        const admission = await transaction.studentAdmission.findUnique({ where: { codeDigest } });
        if (!admission || admission.organizationId === null) {
          throw new StudentAccessError();
        }
        let device = await transaction.studentDevice.findUnique({ where: { requestId } });
        if (
          device &&
          (device.admissionId !== admission.id ||
            device.credentialDigest !== credential.digest ||
            device.mode !== mode)
        ) {
          throw new StudentAccessError();
        }
        if (!device) {
          if (admission.revoked || admission.expiresAt <= now || !admission.issuedById) {
            throw new StudentAccessError();
          }
          await requireComputerCodeIssuer(
            transaction,
            admission.issuedById,
            admission.organizationId,
          );
          const computerName = await generateComputerName(transaction, admission.organizationId);
          const consumed = await transaction.studentAdmission.updateMany({
            where: { id: admission.id, revoked: false, expiresAt: { gt: now } },
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
              organizationId: admission.organizationId,
              computerName,
              credentialDigest: credential.digest,
              mode,
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
          if (!context.organizationId && count >= StudentAccessPolicy.PROFILES_PER_DEVICE) {
            throw new StudentAccessError();
          }
          const meeting =
            context.mode === StudentDeviceMode.SHARED && context.classId !== null
              ? await transaction.classroomMeeting.findFirst({
                  where: { classId: context.classId, status: ClassroomStatus.LIVE },
                  orderBy: { createdAt: 'desc' },
                })
              : null;
          if (context.mode === StudentDeviceMode.SHARED && !context.organizationId && !meeting) {
            throw new StudentAccessError(
              'Your teacher needs to start the class before you can join.',
            );
          }
          await reserveCounter(
            transaction,
            `admission:${context.schoolId}:${now.toISOString().slice(0, 10)}`,
            StudentAccessPolicy.DAILY_SCHOOL_ADMISSIONS,
          );
          let student: { userId: string; created: boolean };
          if (context.organizationId) {
            student = await findOrCreateOrganizationStudent(
              transaction,
              context.organizationId,
              command,
            );
          } else if (context.classId !== null) {
            student = await findOrCreateStudentForQrSignIn(
              transaction,
              context.schoolId,
              context.classId,
              command,
            );
          } else {
            throw new StudentAccessError();
          }
          const { userId, created } = student;
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
          await audit(
            transaction,
            context.schoolId,
            userId,
            created ? StudentSignInAuditEvent.CREATE_LEARNER : StudentSignInAuditEvent.SIGN_IN,
          );
          await transaction.studentDevice.update({
            where: { id: device.id },
            data: { lastSignInAt: now },
          });
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
      async function canAccessClass(classId: string): Promise<boolean> {
        if (!principal.organizationId) {
          return classId === principal.classId;
        }
        const schoolClass = await client.classroomGroup.findFirst({
          where: {
            id: classId,
            organizationId: principal.organizationId,
            deletedAt: null,
            enrollments: { some: { studentId: principal.user.id, active: true } },
          },
        });
        return schoolClass !== null;
      }

      if (command.kind === 'home' || command.kind === 'resume') {
        return true;
      }
      if (command.kind === 'join') {
        const meeting = await client.classroomMeeting.findUnique({
          where: { id: command.classSessionId },
        });
        return (
          meeting !== null &&
          (await canAccessClass(meeting.classId)) &&
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
          (await canAccessClass(participation.meeting.classId)) &&
          (!principal.meetingId || participation.meeting.id === principal.meetingId)
        );
      }
      return false;
    },
  };
  return { store, close: () => client.$disconnect() };
}
