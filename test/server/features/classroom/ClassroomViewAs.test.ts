import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { expect, it, vi } from 'vitest';
import { ClassroomReplySchema, ClassroomFailure, ClassroomPacing } from '#contracts/Classroom.js';
import { ClassroomViewAs } from '#contracts/ClassroomViewAs.js';
import { AccountRole } from '#contracts/AccountRole.js';
import { registerClassroomViewAs } from '../../../../src/server/features/classroom/infrastructure/RegisterClassroomViewAs.js';
import { registerClassroomRoutes } from '../../../../src/server/features/classroom/infrastructure/RegisterClassroomRoutes.js';
import { ClassroomService } from '../../../../src/server/features/classroom/application/ClassroomService.js';
import { MemoryClassroomStore } from './ClassroomFixtures.js';

async function fixture() {
  const api = Fastify();
  const store = new MemoryClassroomStore();
  store.admins.add('admin');
  store.roles.set('admin', AccountRole.STUDENT);
  store.roles.set('student', AccountRole.STUDENT);
  const log = {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
  const readActor = () => Promise.resolve('admin');
  const readSubject = registerClassroomViewAs(api, readActor, store, log);
  registerClassroomRoutes(api, readSubject, new ClassroomService(store), log);
  for (const path of ['materials', 'practice', 'insights']) {
    api.post(`/api/v1/classroom/${path}`, async (request) => ({
      userId: await readSubject(request.headers),
    }));
  }
  api.get('/api/v1/account', async () => ({ userId: await readActor() }));
  await api.ready();
  return { api, store, log };
}

it('authorizes teacher actions under the selected identity and records the real admin', async () => {
  const { api, store, log } = await fixture();
  try {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/classroom/command',
      headers: { [ClassroomViewAs.HEADER]: 'teacher' },
      payload: { kind: 'create-class', name: 'Selected teacher class' },
    });
    expect(response.statusCode).toBe(200);
    expect([...store.classes.values()].map((entry) => entry.teacherId)).toEqual(['teacher']);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin',
        subjectId: 'teacher',
        operation: 'create-class',
        statusCode: 200,
      }),
      'classroom.view_as.completed',
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('Selected teacher class');
    store.admins.delete('admin');
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/v1/classroom/command',
          headers: { [ClassroomViewAs.HEADER]: 'teacher' },
          payload: { kind: 'create-class', name: 'Denied' },
        })
      ).statusCode,
    ).toBe(403);
    expect(store.classes.size).toBe(1);
  } finally {
    await api.close();
  }
});

it('keeps subject roles, directory authorization and unrelated APIs separate', async () => {
  const { api, store } = await fixture();
  try {
    for (const subject of ['teacher', 'student']) {
      for (const path of ['materials', 'practice', 'insights']) {
        const reply = await api.inject({
          method: 'POST',
          url: `/api/v1/classroom/${path}`,
          headers: { [ClassroomViewAs.HEADER]: subject },
          payload: {},
        });
        expect(reply.json<unknown>()).toEqual({ userId: subject });
      }
    }
    const command = (userId: string, payload: object) =>
      api.inject({
        method: 'POST',
        url: '/api/v1/classroom/command',
        headers: { [ClassroomViewAs.HEADER]: userId },
        payload,
      });
    expect((await command('student', { kind: 'create-class', name: 'Denied' })).statusCode).toBe(
      403,
    );
    expect((await command('missing', { kind: 'home' })).statusCode).toBe(403);
    expect((await command('teacher', { kind: 'admin-people' })).statusCode).toBe(403);
    store.admins.add('teacher');
    expect(
      (await command('teacher', { kind: 'admin-view-as', userId: 'student' })).statusCode,
    ).toBe(403);
    expect(
      (
        await api.inject({
          url: '/api/v1/account',
          headers: { [ClassroomViewAs.HEADER]: 'student' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await api.inject({ url: '/api/v1/account' })).json<unknown>()).toEqual({
      userId: 'admin',
    });
    store.admins.delete('admin');
    expect((await command('teacher', { kind: 'home' })).statusCode).toBe(403);
  } finally {
    await api.close();
  }
});

it('joins and leaves as the selected student only after an explicit session action', async () => {
  const { api, store } = await fixture();
  const service = new ClassroomService(store);
  try {
    await service.execute('teacher', { kind: 'create-class', name: 'Class' });
    const schoolClass = [...store.classes.values()][0];
    const course = [...store.courses.values()][0];
    const activity = course?.content.modules[0]?.lessons[0]?.activities[0];
    if (!schoolClass || !activity) {
      throw new Error('Missing classroom fixture.');
    }
    await store.enrollStudent(schoolClass.id, 'student', true);
    await service.execute('teacher', {
      kind: 'start-session',
      classId: schoolClass.id,
      activityId: activity.id,
      pacing: ClassroomPacing.TEACHER,
    });
    const meeting = [...store.meetings.values()][0];
    if (!meeting) {
      throw new Error('Missing meeting fixture.');
    }
    const headers = { [ClassroomViewAs.HEADER]: 'student' };
    const url = '/api/v1/classroom/command';
    expect(
      (await api.inject({ method: 'POST', url, headers, payload: { kind: 'home' } })).statusCode,
    ).toBe(200);
    expect(store.participations.size).toBe(0);
    const deviceId = randomUUID();
    const response = await api.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: 'join', classSessionId: meeting.id, deviceId },
    });
    const reply = ClassroomReplySchema.parse(response.json<unknown>());
    expect(reply.kind).toBe('context');
    if (reply.kind !== 'context') {
      throw new Error('Expected student context.');
    }
    expect(reply.context.participation.studentId).toBe('student');
    expect(
      (
        await api.inject({
          method: 'POST',
          url,
          headers,
          payload: { kind: 'leave', participationId: reply.context.participation.id, deviceId },
        })
      ).statusCode,
    ).toBe(200);
    expect([...store.participations.values()].every((entry) => entry.studentId === 'student')).toBe(
      true,
    );
  } finally {
    await api.close();
  }
});

it('searches both roles and refuses selection after revocation or target deletion', async () => {
  const store = new MemoryClassroomStore();
  const service = new ClassroomService(store);
  store.admins.add('admin');
  store.roles.set('student', AccountRole.STUDENT);
  store.names.set('student', 'Learner');
  const reply = ClassroomReplySchema.parse(
    await service.execute('admin', { kind: 'admin-people', search: 'learn', offset: 0 }),
  );
  expect(reply).toMatchObject({
    kind: 'admin-people',
    people: [{ id: 'student', role: AccountRole.STUDENT }],
    hasMore: false,
  });
  await expect(
    service.execute('student', { kind: 'admin-people', search: '', offset: 0 }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await expect(
    service.execute('admin', { kind: 'admin-view-as', userId: 'teacher' }),
  ).resolves.toMatchObject({ kind: 'admin-view-as', person: { id: 'teacher' } });
  store.roles.delete('teacher');
  await expect(
    service.execute('admin', { kind: 'admin-view-as', userId: 'teacher' }),
  ).rejects.toMatchObject({ code: ClassroomFailure.NOT_FOUND });
  store.admins.delete('admin');
  await expect(
    service.execute('admin', { kind: 'admin-view-as', userId: 'student' }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
});
