import { createHash, createHmac, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaStudentAccessStore } from '../../../src/server/persistence/PrismaStudentAccessStore.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { createAuthDatabase } from '../../../src/server/persistence/AuthDatabase.js';
import { createApi } from '../../../src/server/CreateApi.js';
import { registerStudentAccessRoutes } from '../../../src/server/features/studentAccess/infrastructure/RegisterStudentAccessRoutes.js';
import { registerClassroomRoutes } from '../../../src/server/features/classroom/infrastructure/RegisterClassroomRoutes.js';
import { ClassroomService } from '../../../src/server/features/classroom/application/ClassroomService.js';
import { registerModelGateway } from '../../../src/server/auth/RegisterModelGateway.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';
import {
  StudentAccessPath,
  StudentAccessReplySchema,
  StudentEnrollmentReplySchema,
  StudentSessionCookie,
  type StudentAccessCommand,
} from '#contracts/StudentAccess.js';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import { ModelGatewayConfig } from '../../../src/server/auth/ModelGatewayConfig.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import { ClassroomPacing } from '#contracts/Classroom.js';
import { StudentAccessPolicy } from '../../../src/server/features/studentAccess/application/StudentAccessStore.js';

const environment = readServerEnv(process.env);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});
const database = createPrismaStudentAccessStore(environment.DATABASE_URL);
const classroom = createPrismaClassroomStore(environment.DATABASE_URL);
afterAll(async () => {
  await Promise.all([client.$disconnect(), database.close(), classroom.close()]);
});

async function fixture() {
  const teacherId = randomUUID();
  await client.user.create({
    data: {
      id: teacherId,
      name: 'Teacher fixture',
      email: `${teacherId}@example.test`,
      emailVerified: true,
      role: 'teacher',
    },
  });
  const course = await classroom.store.saveCourse(teacherId, 'Scratch', createCourseContent());
  const schoolClass = await classroom.store.saveClass(teacherId, 'QR class', course.id);
  const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
  let nextAddress = 1;
  const access = registerStudentAccessRoutes(
    api,
    database.store,
    (headers) => Promise.resolve(headers.cookie === 'fixture-staff' ? teacherId : null),
    environment.AUTH_SECRET,
  );
  registerClassroomRoutes(api, access.readUserId, new ClassroomService(classroom.store), {
    warn() {},
    error() {},
  });
  registerModelGateway(
    api,
    access.readUserId,
    { ...environment, OPENAI_API_KEY: 'synthetic-provider-key-not-used' },
    undefined,
    access.service,
  );
  const command = (payload: StudentAccessCommand, device?: string, staff = false) =>
    api.inject({
      method: 'POST',
      url: `${StudentAccessPath}/command`,
      remoteAddress: `127.0.0.${String(nextAddress++)}`,
      headers: {
        origin: 'app.tro.desktop:/',
        ...(device ? { 'x-tro-student-device': device } : {}),
        ...(staff ? { cookie: 'fixture-staff' } : {}),
      },
      payload,
    });

  /** Seed stored grants from before organization activation; retired commands cannot issue these. */
  async function seedLegacyDevice(mode: StudentDeviceMode, classId = schoolClass.id) {
    const school = await client.studentSchool.upsert({
      where: { ownerId: teacherId },
      create: { id: randomUUID(), ownerId: teacherId, name: 'Legacy school fixture' },
      update: {},
    });
    const code = 'ABCDEFGHIJKLMNOP';
    const admissionId = randomUUID();
    await client.studentAdmission.create({
      data: {
        id: admissionId,
        schoolId: school.id,
        classId,
        codeDigest: createHash('sha256').update(admissionId).digest('hex'),
        mode,
        expiresAt: new Date(Date.now() + StudentAccessPolicy.ACTIVATION_MS),
        uses: 1,
      },
    });
    const credential = createHash('sha256').update(randomUUID()).digest('hex');
    const requestId = randomUUID();
    await client.studentDevice.create({
      data: {
        id: randomUUID(),
        admissionId,
        schoolId: school.id,
        classId,
        mode,
        requestId,
        credentialDigest: createHash('sha256').update(credential).digest('hex'),
        expiresAt: new Date(Date.now() + StudentAccessPolicy.DEVICE_MS),
      },
    });
    const device = await database.store.readDevice(
      createHash('sha256').update(credential).digest('hex'),
      new Date(),
    );
    if (device.kind !== 'ready') {
      throw new Error('Missing stored legacy device.');
    }
    return { credential, context: device.context, code, requestId, admissionId };
  }

  async function enroll(
    device: string,
    externalId = '00104a',
    requestId = randomUUID(),
    name = 'Minh',
  ) {
    const response = await command({ kind: 'enroll', requestId, externalId, name }, device);
    if (response.statusCode !== 200) {
      const failure = StudentAccessReplySchema.parse(response.json());
      throw new Error(
        `Student sign-in fixture failed (${String(response.statusCode)}): ${failure.kind === 'failed' ? failure.message : failure.kind}`,
      );
    }
    return StudentEnrollmentReplySchema.parse(response.json());
  }

  async function createLegacyDuplicate(studentId: string): Promise<string> {
    const profile = await client.studentLearnerProfile.findUniqueOrThrow({
      where: { userId: studentId },
    });
    const userId = randomUUID();
    await client.user.create({
      data: {
        id: userId,
        name: 'Legacy duplicate',
        email: null,
        role: 'student',
        learnerProfile: {
          create: { schoolId: profile.schoolId, externalId: profile.externalId },
        },
        classEnrollments: { create: { classId: schoolClass.id } },
      },
    });
    return userId;
  }

  return {
    api,
    access,
    teacherId,
    schoolClass,
    course,
    command,
    seedLegacyDevice,
    enroll,
    createLegacyDuplicate,
  };
}

describe('stored legacy student access compatibility', () => {
  it('reopens QR accounts, retries sign-in safely and keeps Google sessions working', async () => {
    const f = await fixture();
    const authentication = createAuthDatabase(environment);
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const requestId = randomUUID();
      const first = await f.enroll(device.credential, '00104a', requestId);
      const retry = await f.enroll(device.credential, '00104a', requestId);
      expect(retry.user.id).toBe(first.user.id);
      expect(retry.credential).not.toBe(first.credential);
      expect(
        (await client.user.findUniqueOrThrow({ where: { id: first.user.id } })).email,
      ).toBeNull();
      expect(first.user.learner?.externalId).toBe('00104a');
      const second = await f.enroll(device.credential);
      expect(second.user.id).toBe(first.user.id);
      expect((await f.enroll(device.credential, '00104b')).user.id).not.toBe(first.user.id);
      const oldCookie = `${StudentSessionCookie}=${first.credential}`;
      const cookie = `${StudentSessionCookie}=${retry.credential}`;
      expect(
        (
          await f.api.inject({
            url: `${StudentAccessPath}/session`,
            headers: { cookie: oldCookie },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await f.api.inject({ url: `${StudentAccessPath}/session`, headers: { cookie } }))
          .statusCode,
      ).toBe(200);
      const home = await f.api.inject({
        method: 'POST',
        url: '/api/v1/classroom/command',
        headers: { cookie },
        payload: { kind: 'home' },
      });
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain(f.schoolClass.id);
      const forbidden = await f.api.inject({
        method: 'POST',
        url: '/api/v1/classroom/command',
        headers: { cookie },
        payload: { kind: 'create-class', name: 'Forged' },
      });
      expect(forbidden.statusCode).toBe(403);
      expect(
        (await f.api.inject({ url: '/api/v1/pet-world', headers: { cookie } })).statusCode,
      ).toBe(403);

      const token = randomUUID();
      await client.session.create({
        data: {
          id: randomUUID(),
          userId: f.teacherId,
          token,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const context = await authentication.auth.$context;
      const signature = createHmac('sha256', environment.AUTH_SECRET)
        .update(token)
        .digest('base64');
      expect(
        await authentication.readSignedInUserId({
          cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`,
        }),
      ).toBe(f.teacherId);
      expect(await authentication.readSignedInUserId({ cookie })).toBeNull();
    } finally {
      await f.api.close();
      await authentication.close();
    }
  });

  it('keeps stored shared grants restricted to live lessons and rejects legacy activation codes', async () => {
    const f = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.SHARED);
      const denied = await f.command(
        { kind: 'enroll', requestId: randomUUID(), externalId: '001', name: 'An' },
        device.credential,
      );
      expect(denied.statusCode).toBe(403);
      const activity = f.course.content.modules[0]?.lessons[0]?.activities[0];
      if (!activity) {
        throw new Error('Missing activity fixture.');
      }
      await new ClassroomService(classroom.store).execute(f.teacherId, {
        kind: 'start-session',
        classId: f.schoolClass.id,
        activityId: activity.id,
        pacing: ClassroomPacing.TEACHER,
      });
      const student = await f.enroll(device.credential);
      await database.store.revokeSession(
        createHash('sha256').update(student.credential).digest('hex'),
      );
      const returning = await f.enroll(device.credential, '00104a', randomUUID(), '');
      expect(returning.user.id).toBe(student.user.id);
      expect(returning.user.name).toBe('Minh');
      const cookie = `${StudentSessionCookie}=${returning.credential}`;
      expect(student.user.learner?.mode).toBe(StudentDeviceMode.SHARED);
      const secondDevice = await f.command({
        kind: 'activate',
        code: device.code,
        requestId: randomUUID(),
      });
      expect(secondDevice.statusCode).toBe(400);
      await client.classroomMeeting.updateMany({
        where: { classId: f.schoolClass.id },
        data: { status: 'ended' },
      });
      expect(
        (await f.api.inject({ url: `${StudentAccessPath}/session`, headers: { cookie } }))
          .statusCode,
      ).toBe(401);
      expect(
        (await f.api.inject({ url: '/api/v1/model/credential', headers: { cookie } })).statusCode,
      ).toBe(401);
    } finally {
      await f.api.close();
    }
  });

  it('rejects retired setup and roster commands while preserving stored accounts and metadata', async () => {
    const f = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const first = await f.enroll(device.credential, '001');
      await client.studentLearnerProfile.update({
        where: { userId: first.user.id },
        data: { rosterName: 'Stored roster name' },
      });
      const rows = [{ externalId: '001', name: 'Replacement name' }];
      const commands = [
        {
          kind: 'create-admission',
          classId: f.schoolClass.id,
          schoolName: 'Old school',
          mode: 'personal',
        },
        { kind: 'revoke-admission', classId: f.schoolClass.id },
        { kind: 'preview-roster', classId: f.schoolClass.id, rows },
        { kind: 'apply-roster', classId: f.schoolClass.id, rows, revision: 0 },
      ];
      for (const command of commands) {
        const response = await f.api.inject({
          method: 'POST',
          url: `${StudentAccessPath}/command`,
          headers: { cookie: 'fixture-staff', origin: 'app.tro.desktop:/' },
          payload: command,
        });
        expect(response.statusCode).toBe(400);
      }
      const admission = await client.studentAdmission.findUniqueOrThrow({
        where: { id: device.admissionId },
      });
      await expect(
        database.store.activateDevice(
          admission.codeDigest,
          randomUUID(),
          { credential: 'a'.repeat(64), digest: 'b'.repeat(64) },
          new Date(),
        ),
      ).rejects.toThrow();
      expect(await client.studentAdmission.count({ where: { classId: f.schoolClass.id } })).toBe(1);
      expect(admission.revoked).toBe(false);
      expect(
        await client.studentLearnerProfile.findUniqueOrThrow({ where: { userId: first.user.id } }),
      ).toMatchObject({ rosterName: 'Stored roster name' });
      const cookie = `${StudentSessionCookie}=${first.credential}`;
      const signedIn = await f.api.inject({
        url: `${StudentAccessPath}/session`,
        headers: { cookie },
      });
      expect(signedIn.statusCode).toBe(200);
      expect(
        StudentEnrollmentReplySchema.omit({ credential: true }).parse(signedIn.json()).user,
      ).toMatchObject({ id: first.user.id, name: 'Minh' });
    } finally {
      await f.api.close();
    }
  });

  it('recovers on another authorized device after sign-out or expiry without changing the name', async () => {
    const f = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const first = await f.enroll(device.credential);
      const activity = f.course.content.modules[0]?.lessons[0]?.activities[0];
      if (!activity) {
        throw new Error('Missing activity fixture.');
      }
      const attemptId = randomUUID();
      await client.classroomMeeting.create({
        data: {
          id: randomUUID(),
          classId: f.schoolClass.id,
          status: 'ended',
          phase: 'practice',
          pacing: ClassroomPacing.TEACHER,
          currentActivityId: activity.id,
          participations: {
            create: {
              id: randomUUID(),
              studentId: first.user.id,
              deviceId: randomUUID(),
              leaseUntil: new Date(0),
              left: true,
              attempts: {
                create: {
                  id: attemptId,
                  activityId: activity.id,
                  evidence: [],
                  helpSummary: 'Saved learner work',
                },
              },
            },
          },
        },
      });
      await database.store.revokeSession(
        createHash('sha256').update(first.credential).digest('hex'),
      );
      const otherDevice = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const recovered = await f.enroll(otherDevice.credential, '00104a', randomUUID(), '');
      expect(recovered.user.id).toBe(first.user.id);
      expect(recovered.user.name).toBe('Minh');
      await client.studentLearnerSession.updateMany({
        where: { userId: first.user.id },
        data: { expiresAt: new Date(0) },
      });
      const afterExpiry = await f.enroll(device.credential, '00104a', randomUUID(), 'Other name');
      expect(afterExpiry.user.id).toBe(first.user.id);
      expect(afterExpiry.user.name).toBe('Minh');
      expect(
        await client.classroomAttempt.findFirst({
          where: { id: attemptId, participation: { studentId: afterExpiry.user.id } },
        }),
      ).toMatchObject({ helpSummary: 'Saved learner work' });
      expect(await client.studentLearnerProfile.count({ where: { userId: first.user.id } })).toBe(
        1,
      );
      expect(
        await client.studentAccessAudit.count({
          where: { actorId: first.user.id, operation: 'sign-in-existing-learner' },
        }),
      ).toBe(2);
    } finally {
      await f.api.close();
    }
  });

  it('requires a name only for a new QR and keeps concurrent first scans on one account', async () => {
    const f = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const missingName = await f.command(
        {
          kind: 'enroll',
          externalId: '00104a',
          requestId: randomUUID(),
          name: '',
        },
        device.credential,
      );
      expect(missingName.statusCode).toBe(403);
      expect(StudentAccessReplySchema.parse(missingName.json())).toMatchObject({
        kind: 'failed',
        message: 'Enter your name for your first sign-in.',
      });
      const otherDevice = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const students = await Promise.all([
        f.enroll(device.credential),
        f.enroll(otherDevice.credential),
      ]);
      expect(new Set(students.map((student) => student.user.id)).size).toBe(1);
      expect(
        await client.studentLearnerProfile.count({
          where: { schoolId: device.context.schoolId, externalId: '00104a' },
        }),
      ).toBe(1);
    } finally {
      await f.api.close();
    }
  });

  it('keeps QR recovery within the configured school and class and preserves exact IDs', async () => {
    const f = await fixture();
    const otherSchool = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const first = await f.enroll(device.credential, '001a');
      const anotherClass = await classroom.store.saveClass(f.teacherId, 'Other class', f.course.id);
      const otherClassDevice = await f.seedLegacyDevice(
        StudentDeviceMode.PERSONAL,
        anotherClass.id,
      );
      const otherSchoolDevice = await otherSchool.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const students = await Promise.all([
        f.enroll(otherClassDevice.credential, '001a'),
        otherSchool.enroll(otherSchoolDevice.credential, '001a'),
        f.enroll(device.credential, '001A'),
        f.enroll(device.credential, '1a'),
      ]);
      expect(new Set([first.user.id, ...students.map((student) => student.user.id)]).size).toBe(5);
      expect((await f.enroll(device.credential, '001a', randomUUID(), '')).user.id).toBe(
        first.user.id,
      );
    } finally {
      await Promise.all([f.api.close(), otherSchool.api.close()]);
    }
  });

  it('refuses ambiguous legacy QR accounts without merging or creating another account', async () => {
    const f = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const first = await f.enroll(device.credential);
      const duplicateId = await f.createLegacyDuplicate(first.user.id);
      const response = await f.command(
        {
          kind: 'enroll',
          requestId: randomUUID(),
          externalId: '00104a',
          name: '',
        },
        device.credential,
      );
      expect(response.statusCode).toBe(403);
      expect(StudentAccessReplySchema.parse(response.json())).toMatchObject({
        kind: 'failed',
        message: 'This student ID is linked to multiple accounts. Ask your teacher for help.',
      });
      const profiles = await client.studentLearnerProfile.findMany({
        where: { schoolId: device.context.schoolId, externalId: '00104a' },
      });
      expect(profiles.map((profile) => profile.userId).sort()).toEqual(
        [first.user.id, duplicateId].sort(),
      );
      expect(
        await client.studentLearnerSession.count({
          where: { userId: { in: [first.user.id, duplicateId] } },
        }),
      ).toBe(1);
    } finally {
      await f.api.close();
    }
  });

  it('does not restore revoked enrollment, elevated accounts or revoked machine access', async () => {
    const f = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const first = await f.enroll(device.credential);
      const signIn = () =>
        f.command(
          {
            kind: 'enroll',
            requestId: randomUUID(),
            externalId: '00104a',
            name: '',
          },
          device.credential,
        );
      await client.classroomEnrollment.update({
        where: { classId_studentId: { classId: f.schoolClass.id, studentId: first.user.id } },
        data: { active: false },
      });
      expect((await signIn()).statusCode).toBe(403);
      await client.classroomEnrollment.update({
        where: { classId_studentId: { classId: f.schoolClass.id, studentId: first.user.id } },
        data: { active: true },
      });
      await client.user.update({ where: { id: first.user.id }, data: { isAdmin: true } });
      expect((await signIn()).statusCode).toBe(403);
      await client.user.update({
        where: { id: first.user.id },
        data: { isAdmin: false, role: 'teacher' },
      });
      expect((await signIn()).statusCode).toBe(403);
      await client.user.update({
        where: { id: first.user.id },
        data: { role: 'student', email: 'linked@example.test' },
      });
      expect((await signIn()).statusCode).toBe(403);
      await client.user.update({ where: { id: first.user.id }, data: { email: null } });
      await client.studentAdmission.update({
        where: { id: device.admissionId },
        data: { revoked: true },
      });
      expect((await signIn()).statusCode).toBe(403);
      expect(await client.studentLearnerSession.count({ where: { userId: first.user.id } })).toBe(
        1,
      );
    } finally {
      await f.api.close();
    }
  });

  it('binds model credentials to revocable sessions and reserves concurrent allowances atomically', async () => {
    const f = await fixture();
    try {
      const device = await f.seedLegacyDevice(StudentDeviceMode.PERSONAL);
      const student = await f.enroll(device.credential);
      const cookie = `${StudentSessionCookie}=${student.credential}`;
      const principal = await f.access.service.readPrincipal({ cookie });
      if (!principal) {
        throw new Error('Missing learner principal.');
      }
      const counterId = `model-user:${student.user.id}:${new Date().toISOString().slice(0, 10)}`;
      await client.studentAccessUsage.create({
        data: { id: counterId, count: StudentAccessPolicy.DAILY_LEARNER_MODEL_REQUESTS - 1 },
      });
      const admitted = await Promise.all(
        Array.from({ length: 4 }, () =>
          database.store.reserveModelRequest(principal.sessionId, new Date()),
        ),
      );
      expect(admitted.filter(Boolean)).toHaveLength(1);
      const model = await f.api.inject({ url: '/api/v1/model/credential', headers: { cookie } });
      expect(model.statusCode).toBe(200);
      const credential = ModelCredentialSchema.parse(model.json());
      const deniedOrigin = await f.api.inject({
        method: 'POST',
        url: `${StudentAccessPath}/sign-out`,
        headers: { cookie, origin: 'https://attacker.test' },
      });
      expect(deniedOrigin.statusCode).toBe(403);
      await f.api.inject({
        method: 'POST',
        url: `${StudentAccessPath}/sign-out`,
        headers: { cookie, origin: 'app.tro.desktop:/' },
      });
      expect(
        (await f.api.inject({ url: `${StudentAccessPath}/session`, headers: { cookie } }))
          .statusCode,
      ).toBe(401);
      const response = await f.api.inject({
        method: 'POST',
        url: '/api/v1/model/responses',
        headers: { authorization: `Bearer ${credential.token}` },
        payload: { model: ModelGatewayConfig.model, input: 'synthetic test', stream: false },
      });
      expect(response.statusCode).toBe(403);
      expect(
        await database.store.readSession(
          createHash('sha256').update(student.credential).digest('hex'),
          new Date(),
        ),
      ).toBeNull();
    } finally {
      await f.api.close();
    }
  });
});
