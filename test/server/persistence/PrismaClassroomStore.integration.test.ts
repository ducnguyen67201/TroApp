import { z } from 'zod';
import { createHmac, randomUUID } from 'node:crypto';
import { AccountRole } from '#contracts/AccountRole.js';
import { createAccountRoleAdministration } from '../../../src/server/persistence/AccountRoles.js';
import { createAuthDatabase } from '../../../src/server/persistence/AuthDatabase.js';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { ClassroomService } from '../../../src/server/features/classroom/application/ClassroomService.js';
import { registerClassroomRoutes } from '../../../src/server/features/classroom/infrastructure/RegisterClassroomRoutes.js';
import { createApi } from '../../../src/server/CreateApi.js';
import { createServerLogger } from '../../../src/server/Logger.js';
import {
  ClassroomReplySchema,
  ClassroomPacing,
  ClassroomPhase,
  type TeachingContext,
} from '#contracts/Classroom.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';

const environment = readServerEnv(process.env);
const database = createPrismaClassroomStore(environment.DATABASE_URL);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});
afterAll(async () => {
  await database.close();
  await client.$disconnect();
});

async function createFixture() {
  const teacher = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  await client.user.createMany({
    data: [teacher, first, second].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      role: id === teacher ? AccountRole.TEACHER : AccountRole.STUDENT,
    })),
  });
  const service = new ClassroomService(database.store);
  const course = await database.store.saveCourse(teacher, 'Scratch', createCourseContent());
  const schoolClass = await database.store.saveClass(teacher, 'Class A', course.id);
  const activity = course.content.modules[0]?.lessons[0]?.activities[0];
  const nextActivity = course.content.modules[0]?.lessons[0]?.activities[1];
  if (!activity || !nextActivity) {
    throw new Error('Missing activities.');
  }
  await service.execute(teacher, {
    kind: 'enroll',
    classId: schoolClass.id,
    email: `${first}@example.test`,
  });
  await service.execute(teacher, {
    kind: 'enroll',
    classId: schoolClass.id,
    email: `${second}@example.test`,
  });
  await service.execute(teacher, {
    kind: 'start-session',
    classId: schoolClass.id,
    activityId: activity.id,
    pacing: ClassroomPacing.TEACHER,
  });
  const meeting = (await database.store.listMeetings(schoolClass.id))[0];
  if (!meeting) {
    throw new Error('Missing meeting.');
  }
  const join = async (student: string): Promise<TeachingContext> => {
    const reply = await service.execute(student, {
      kind: 'join',
      classSessionId: meeting.id,
      deviceId: randomUUID(),
    });
    if (reply.kind !== 'context') {
      throw new Error('Join failed.');
    }
    return reply.context;
  };
  return { teacher, first, second, schoolClass, meeting, activity, nextActivity, service, join };
}

function mutation(context: TeachingContext) {
  return {
    participationId: context.participation.id,
    deviceId: context.participation.deviceId,
    activityId: context.activity.id,
    contextVersion: context.meeting.contextVersion,
    progressVersion: context.attempt.progressVersion,
  };
}

describe('classroom PostgreSQL journey', () => {
  it('deletes an inactive class through authenticated HTTP while preserving submitted work', async () => {
    const fixture = await createFixture();
    const joined = await fixture.join(fixture.first);
    const saved = await fixture.service.execute(fixture.first, {
      kind: 'save-workspace',
      ...mutation(joined),
      url: 'https://scratch.mit.edu/projects/123/',
    });
    if (saved.kind !== 'context') {
      throw new Error('Workspace missing.');
    }
    const prepared = await fixture.service.execute(fixture.first, {
      kind: 'prepare-submission',
      ...mutation(saved.context),
    });
    if (prepared.kind !== 'prepared') {
      throw new Error('Preparation missing.');
    }
    const submitted = await fixture.service.execute(fixture.first, {
      kind: 'submit-work',
      ...mutation(saved.context),
      preparedSubmissionId: prepared.preparation.id,
      idempotencyKey: randomUUID(),
    });
    if (submitted.kind !== 'submitted') {
      throw new Error('Submission missing.');
    }
    const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
    registerClassroomRoutes(
      api,
      (headers) =>
        Promise.resolve(typeof headers['x-test-user'] === 'string' ? headers['x-test-user'] : null),
      fixture.service,
      createServerLogger(environment.APP_ENV),
    );
    const remove = (userId: string) =>
      api.inject({
        method: 'POST',
        url: '/api/v1/classroom/command',
        headers: { 'x-test-user': userId },
        payload: { kind: 'delete-class', classId: fixture.schoolClass.id },
      });
    try {
      expect((await remove(fixture.first)).statusCode).toBe(403);
      expect((await remove(fixture.teacher)).statusCode).toBe(409);
      await fixture.service.execute(fixture.teacher, {
        kind: 'end-session',
        classSessionId: fixture.meeting.id,
        contextVersion: fixture.meeting.contextVersion,
      });
      expect((await remove(fixture.teacher)).statusCode).toBe(200);
      expect(await database.store.readClass(fixture.schoolClass.id)).toBeNull();
      expect(await database.store.listClasses(fixture.first)).toEqual([]);
      const retained = await client.classroomGroup.findUnique({
        where: { id: fixture.schoolClass.id },
      });
      expect(retained?.deletedAt).toBeInstanceOf(Date);
      expect(
        await client.classroomSubmission.findUnique({ where: { id: submitted.receipt.id } }),
      ).not.toBeNull();
      await expect(
        fixture.service.execute(fixture.first, {
          kind: 'context',
          participationId: joined.participation.id,
          deviceId: joined.participation.deviceId,
          activityId: joined.activity.id,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await api.close();
    }
  });

  it('persists independent work and an idempotent hand-in visible only to the teacher', async () => {
    const fixture = await createFixture();
    const first = await fixture.join(fixture.first);
    const second = await fixture.join(fixture.second);
    const reply = await fixture.service.execute(fixture.first, {
      kind: 'save-workspace',
      ...mutation(first),
      url: 'https://scratch.mit.edu/projects/123/',
    });
    if (reply.kind !== 'context') {
      throw new Error('Workspace failed.');
    }
    const updated = reply.context;
    expect(second.attempt.workspaceUrl).toBeNull();
    const prepared = await fixture.service.execute(fixture.first, {
      kind: 'prepare-submission',
      ...mutation(updated),
    });
    if (prepared.kind !== 'prepared') {
      throw new Error('Preparation failed.');
    }
    const command = {
      kind: 'submit-work' as const,
      ...mutation(updated),
      preparedSubmissionId: prepared.preparation.id,
      idempotencyKey: randomUUID(),
    };
    const receipts = await Promise.all([
      fixture.service.execute(fixture.first, command),
      fixture.service.execute(fixture.first, command),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    const resumed = await fixture.service.execute(fixture.first, {
      kind: 'join',
      classSessionId: fixture.meeting.id,
      deviceId: updated.participation.deviceId,
    });
    expect(resumed.kind).toBe('context');
    const receipt = receipts[0];
    if (resumed.kind === 'context' && receipt.kind === 'submitted') {
      expect(resumed.context.latestSubmission).toEqual(receipt.receipt);
    } else {
      throw new Error('Rejoining did not restore the receipt.');
    }
    expect(
      await client.classroomSubmission.count({ where: { attemptId: updated.attempt.id } }),
    ).toBe(1);
    const roster = await fixture.service.execute(fixture.teacher, {
      kind: 'session-roster',
      classSessionId: fixture.meeting.id,
    });
    expect(roster.kind).toBe('roster');
    if (roster.kind === 'roster') {
      expect(
        roster.roster.find((student) => student.studentId === fixture.first)?.submissions,
      ).toHaveLength(1);
    }
    await expect(
      fixture.service.execute(fixture.second, {
        kind: 'session-roster',
        classSessionId: fixture.meeting.id,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('allows only one concurrent version update and restores progress after rejoining', async () => {
    const fixture = await createFixture();
    const context = await fixture.join(fixture.first);
    const command = {
      kind: 'update-session' as const,
      classSessionId: fixture.meeting.id,
      contextVersion: 1,
      activityId: fixture.nextActivity.id,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.TEACHER,
    };
    const results = await Promise.allSettled([
      fixture.service.execute(fixture.teacher, command),
      fixture.service.execute(fixture.teacher, command),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await database.store.readMeeting(fixture.meeting.id))?.contextVersion).toBe(2);
    const again = await fixture.join(fixture.first);
    expect(again.participation.id).toBe(context.participation.id);
    expect(again.activity.id).toBe(fixture.nextActivity.id);
    expect(
      await client.classroomAttempt.count({ where: { participationId: context.participation.id } }),
    ).toBe(2);
  });

  it('validates authenticated HTTP input and refuses forged identity and student teacher commands', async () => {
    const fixture = await createFixture();
    const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
    registerClassroomRoutes(
      api,
      (headers) =>
        Promise.resolve(typeof headers['x-test-user'] === 'string' ? headers['x-test-user'] : null),
      fixture.service,
      createServerLogger(environment.APP_ENV),
    );
    try {
      const call = (user: string | null, payload: unknown) =>
        api.inject({
          method: 'POST',
          url: '/api/v1/classroom/command',
          headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
          payload: JSON.stringify(payload),
        });
      expect((await call(null, { kind: 'home' })).statusCode).toBe(401);
      expect(
        (await call(fixture.first, { kind: 'home', studentId: fixture.second })).statusCode,
      ).toBe(400);
      expect(
        (
          await call(fixture.first, {
            kind: 'end-session',
            classSessionId: fixture.meeting.id,
            contextVersion: 1,
          })
        ).statusCode,
      ).toBe(403);
      const response = await call(fixture.first, {
        kind: 'join',
        classSessionId: fixture.meeting.id,
        deviceId: randomUUID(),
      });
      const body: unknown = JSON.parse(response.body);
      expect(ClassroomReplySchema.parse(body).kind).toBe('context');
    } finally {
      await api.close();
    }
  });

  it('sends an authenticated live update when the teacher changes sections', async () => {
    const fixture = await createFixture();
    const context = await fixture.join(fixture.first);
    const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
    registerClassroomRoutes(
      api,
      (headers) =>
        Promise.resolve(typeof headers['x-test-user'] === 'string' ? headers['x-test-user'] : null),
      fixture.service,
      createServerLogger(environment.APP_ENV),
    );
    const abort = new AbortController();
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      const query = new URLSearchParams({
        participationId: context.participation.id,
        deviceId: context.participation.deviceId,
        activityId: context.activity.id,
      });
      const response = await fetch(`${address}/api/v1/classroom/updates?${query.toString()}`, {
        headers: { 'x-test-user': fixture.first },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Missing update stream.');
      }
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain('connected');
      await fixture.service.execute(fixture.teacher, {
        kind: 'update-session',
        classSessionId: fixture.meeting.id,
        contextVersion: 1,
        activityId: fixture.nextActivity.id,
        phase: ClassroomPhase.PRACTICE,
        pacing: ClassroomPacing.TEACHER,
      });
      const event = await reader.read();
      expect(new TextDecoder().decode(event.value)).toContain('data: refresh');
      await reader.cancel();
    } finally {
      abort.abort();
      await api.close();
    }
  });
});

it('persists role changes by verified email and prevents authenticated self-promotion', async () => {
  const id = randomUUID();
  const token = randomUUID();
  await client.user.create({
    data: { id, name: 'Student', email: `${id}@example.test`, emailVerified: true },
  });
  expect(await database.store.readAccountRole(id)).toBe(AccountRole.STUDENT);
  await client.session.create({
    data: { id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600000) },
  });
  const auth = createAuthDatabase(environment);
  const administration = createAccountRoleAdministration(environment.DATABASE_URL);
  try {
    const signature = createHmac('sha256', environment.AUTH_SECRET).update(token).digest('base64');
    const authContext = await auth.auth.$context;
    const cookie = `${authContext.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
    const session = await auth.auth.handler(
      new Request(`${environment.AUTH_BASE_URL}/api/auth/get-session`, { headers: { cookie } }),
    );
    const body: unknown = await session.json();
    const parsed = z.looseObject({ user: z.looseObject({ id: z.string() }) }).parse(body);
    expect(parsed.user.id).toBe(id);
    await auth.auth.handler(
      new Request(`${environment.AUTH_BASE_URL}/api/auth/update-user`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', origin: environment.AUTH_BASE_URL },
        body: JSON.stringify({ role: AccountRole.TEACHER }),
      }),
    );
    expect(await database.store.readAccountRole(id)).toBe(AccountRole.STUDENT);
    expect(
      await administration.assignRoleToVerifiedEmail(`${id}@example.test`, AccountRole.TEACHER),
    ).toBe(true);
    expect(await database.store.readAccountRole(id)).toBe(AccountRole.TEACHER);
    await client.user.update({ where: { id }, data: { emailVerified: false } });
    expect(
      await administration.assignRoleToVerifiedEmail(`${id}@example.test`, AccountRole.STUDENT),
    ).toBe(false);
  } finally {
    await administration.close();
    await auth.close();
  }
});

it('persists invitation enrollment and rejects a revoked code', async () => {
  const fixture = await createFixture();
  const invite = await fixture.service.execute(fixture.teacher, {
    kind: 'create-invitation',
    classId: fixture.schoolClass.id,
    email: `${fixture.first}@example.test`,
  });
  if (invite.kind !== 'invitation') {
    throw new Error('Missing invitation.');
  }
  await fixture.service.execute(fixture.teacher, {
    kind: 'revoke',
    classId: fixture.schoolClass.id,
    studentId: fixture.first,
  });
  await fixture.service.execute(fixture.first, {
    kind: 'accept-invitation',
    code: invite.invitation.code,
  });
  expect(await database.store.isEnrolled(fixture.schoolClass.id, fixture.first)).toBe(true);
  expect(await database.store.readAccountRole(fixture.first)).toBe(AccountRole.STUDENT);
  await fixture.service.execute(fixture.teacher, {
    kind: 'revoke-invitations',
    classId: fixture.schoolClass.id,
  });
  await expect(
    fixture.service.execute(fixture.first, {
      kind: 'accept-invitation',
      code: invite.invitation.code,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('restores persisted participation through authenticated HTTP after desktop restart', async () => {
  const fixture = await createFixture();
  const joined = await fixture.join(fixture.first);
  await client.classroomParticipation.update({
    where: { id: joined.participation.id },
    data: { leaseUntil: new Date(0) },
  });
  const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
  registerClassroomRoutes(
    api,
    (headers) =>
      Promise.resolve(typeof headers['x-test-user'] === 'string' ? headers['x-test-user'] : null),
    new ClassroomService(database.store),
    createServerLogger(environment.APP_ENV),
  );
  const deviceId = randomUUID();
  const resume = (userId: string) =>
    api.inject({
      method: 'POST',
      url: '/api/v1/classroom/command',
      headers: { 'x-test-user': userId },
      payload: { kind: 'resume', deviceId },
    });
  try {
    const response = await resume(fixture.first);
    expect(response.statusCode).toBe(200);
    const body: unknown = JSON.parse(response.body);
    const reply = ClassroomReplySchema.parse(body);
    if (reply.kind !== 'context') {
      throw new Error('Missing restored participation.');
    }
    expect(reply.context.participation.id).toBe(joined.participation.id);
    expect(reply.context.participation.deviceId).toBe(deviceId);
    expect(reply.context.attempt.id).toBe(joined.attempt.id);
    const otherBody: unknown = JSON.parse((await resume(fixture.second)).body);
    expect(ClassroomReplySchema.parse(otherBody)).toEqual({ kind: 'ok' });
    await fixture.service.execute(fixture.first, {
      kind: 'leave',
      participationId: joined.participation.id,
      deviceId,
    });
    const leftBody: unknown = JSON.parse((await resume(fixture.first)).body);
    expect(ClassroomReplySchema.parse(leftBody)).toEqual({ kind: 'ok' });
  } finally {
    await api.close();
  }
});
