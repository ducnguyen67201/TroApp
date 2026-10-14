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
  StudentDeviceCredentialSchema,
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

  async function activate(mode: StudentDeviceMode) {
    const issued = StudentAccessReplySchema.parse(
      (
        await command(
          { kind: 'create-admission', classId: schoolClass.id, schoolName: 'School fixture', mode },
          undefined,
          true,
        )
      ).json(),
    );
    if (issued.kind !== 'admission') {
      throw new Error('Missing admission fixture.');
    }
    const requestId = randomUUID();
    const response = await command({ kind: 'activate', code: issued.code, requestId });
    const device = StudentDeviceCredentialSchema.parse(response.json());
    return { ...device, code: issued.code, requestId };
  }

  async function enroll(device: string, externalId = '00104a', requestId = randomUUID()) {
    const response = await command({ kind: 'enroll', requestId, externalId, name: 'Minh' }, device);
    return StudentEnrollmentReplySchema.parse(response.json());
  }

  return { api, access, teacherId, schoolClass, course, command, activate, enroll };
}

describe('email-free student access', () => {
  it('creates isolated canonical users, retries onboarding safely and keeps Google sessions working', async () => {
    const f = await fixture();
    const authentication = createAuthDatabase(environment);
    try {
      const device = await f.activate(StudentDeviceMode.PERSONAL);
      const replay = StudentDeviceCredentialSchema.parse(
        (
          await f.command({ kind: 'activate', code: device.code, requestId: device.requestId })
        ).json(),
      );
      expect(replay.credential).toBe(device.credential);
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
      expect(second.user.id).not.toBe(first.user.id);
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
      expect(
        (
          await f.command(
            {
              kind: 'create-admission',
              classId: randomUUID(),
              schoolName: 'Other',
              mode: StudentDeviceMode.PERSONAL,
            },
            undefined,
            true,
          )
        ).statusCode,
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

  it('requires live shared lessons, permits one device redemption and invalidates shared sessions when class ends', async () => {
    const f = await fixture();
    try {
      const device = await f.activate(StudentDeviceMode.SHARED);
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
      const cookie = `${StudentSessionCookie}=${student.credential}`;
      expect(student.user.learner?.mode).toBe(StudentDeviceMode.SHARED);
      const secondDevice = await f.command({
        kind: 'activate',
        code: device.code,
        requestId: randomUUID(),
      });
      expect(secondDevice.statusCode).toBe(403);
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

  it('reviews metadata without merging claims and rejects stale/conflicting batches', async () => {
    const f = await fixture();
    try {
      const device = await f.activate(StudentDeviceMode.PERSONAL);
      const first = await f.enroll(device.credential, '001');
      const rows = [{ externalId: '001', name: 'School roster name' }];
      const preview = StudentAccessReplySchema.parse(
        (
          await f.command(
            { kind: 'preview-roster', classId: f.schoolClass.id, rows },
            undefined,
            true,
          )
        ).json(),
      );
      if (preview.kind !== 'roster-preview') {
        throw new Error('Missing roster preview.');
      }
      expect(preview).toMatchObject({ matched: 1, conflicts: [] });
      const apply = {
        kind: 'apply-roster' as const,
        classId: f.schoolClass.id,
        rows,
        revision: preview.revision,
      };
      expect((await f.command(apply, undefined, true)).statusCode).toBe(200);
      expect((await f.command(apply, undefined, true)).statusCode).toBe(200);
      expect((await client.user.findUniqueOrThrow({ where: { id: first.user.id } })).name).toBe(
        'Minh',
      );
      expect(
        (await client.studentLearnerProfile.findUniqueOrThrow({ where: { userId: first.user.id } }))
          .rosterName,
      ).toBe('School roster name');
      await f.enroll(device.credential, '001');
      const conflict = StudentAccessReplySchema.parse(
        (
          await f.command(
            { kind: 'preview-roster', classId: f.schoolClass.id, rows },
            undefined,
            true,
          )
        ).json(),
      );
      expect(conflict).toMatchObject({ conflicts: ['001'] });
      expect(
        (await f.command({ ...apply, revision: preview.revision + 1 }, undefined, true)).statusCode,
      ).toBe(403);
      const cookie = `${StudentSessionCookie}=${first.credential}`;
      const signedIn = await f.api.inject({
        url: `${StudentAccessPath}/session`,
        headers: { cookie },
      });
      expect(
        StudentEnrollmentReplySchema.omit({ credential: true }).parse(signedIn.json()).user.learner
          ?.provisional,
      ).toBe(true);
    } finally {
      await f.api.close();
    }
  });

  it('binds model credentials to revocable sessions and reserves concurrent allowances atomically', async () => {
    const f = await fixture();
    try {
      const device = await f.activate(StudentDeviceMode.PERSONAL);
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
