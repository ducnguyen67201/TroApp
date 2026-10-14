import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomAdminCapability,
  ClassroomOrganizationCapability,
  ClassroomFailure,
} from '#contracts/Classroom.js';
import { ClassroomService } from '../../../../src/server/features/classroom/application/ClassroomService.js';
import { registerClassroomRoutes } from '../../../../src/server/features/classroom/infrastructure/RegisterClassroomRoutes.js';
import { createCourseContent, MemoryClassroomStore } from './ClassroomFixtures.js';

/* Frozen pre-admin wire shape: keep independent of current contract schemas so
   additive fields cannot silently break already installed strict desktop clients. */
const legacyShortText = z.string().trim().min(1).max(200);
const LegacyHomeReplySchema = z.strictObject({
  kind: z.literal('home'),
  home: z.strictObject({
    role: z.enum(['student', 'teacher']),
    courses: z
      .array(
        z.strictObject({
          id: z.uuid(),
          title: legacyShortText,
          activities: z.array(z.strictObject({ id: z.uuid(), title: legacyShortText })).max(40),
        }),
      )
      .max(100),
    classes: z
      .array(
        z.strictObject({
          schoolClass: z.strictObject({
            id: z.uuid(),
            teacherId: z.string().min(1),
            name: legacyShortText,
            courseRevisionId: z.uuid(),
          }),
          meetings: z
            .array(
              z.strictObject({
                id: z.uuid(),
                classId: z.uuid(),
                status: z.enum(['live', 'ended']),
                phase: z.enum(['explanation', 'practice', 'submission', 'review']),
                pacing: z.enum(['teacher', 'student']),
                currentActivityId: z.uuid(),
                contextVersion: z.number().int().positive(),
              }),
            )
            .max(100),
        }),
      )
      .max(100),
  }),
});

async function createClassroomApi() {
  const api = Fastify();
  const store = new MemoryClassroomStore();
  const course = await store.saveCourse('teacher', 'Scratch', createCourseContent());
  const schoolClass = await store.saveClass('teacher', 'Class A', course.id);
  const service = new ClassroomService(store);
  registerClassroomRoutes(api, () => Promise.resolve('teacher'), service, {
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  });
  const home = {
    role: AccountRole.TEACHER,
    courses: [
      {
        id: course.id,
        title: course.title,
        activities: course.content.modules.flatMap((module) =>
          module.lessons.flatMap((lesson) =>
            lesson.activities.map(({ id, title }) => ({ id, title })),
          ),
        ),
      },
    ],
    classes: [{ schoolClass, meetings: [] }],
  };
  return { api, store, schoolClass, home };
}

describe('classroom HTTP response compatibility', () => {
  it.each([undefined, '0', '2'])(
    'preserves legacy homes when the capability version is %s',
    async (capabilityVersion) => {
      const { api, store, home } = await createClassroomApi();
      store.admins.add('teacher');
      try {
        const response = await api.inject({
          method: 'POST',
          url: '/api/v1/classroom/command',
          headers: capabilityVersion
            ? { [ClassroomAdminCapability.HEADER]: capabilityVersion }
            : {},
          payload: { kind: 'home' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(LegacyHomeReplySchema.parse(response.json<unknown>())).toEqual({
          kind: 'home',
          home,
        });
      } finally {
        await api.close();
      }
    },
  );

  it('returns current stored admin metadata to capable clients without granting authority', async () => {
    const { api, store, schoolClass, home } = await createClassroomApi();
    const headers = {
      [ClassroomAdminCapability.HEADER]: ClassroomAdminCapability.VERSION,
    };
    try {
      for (const isAdmin of [false, true, false]) {
        if (isAdmin) {
          store.admins.add('teacher');
        } else {
          store.admins.delete('teacher');
        }
        const response = await api.inject({
          method: 'POST',
          url: '/api/v1/classroom/command',
          headers,
          payload: { kind: 'home' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json<unknown>()).toEqual({ kind: 'home', home: { ...home, isAdmin } });
        for (const payload of [
          { kind: 'admin-classes' },
          { kind: 'admin-class', classId: schoolClass.id },
        ]) {
          const adminResponse = await api.inject({
            method: 'POST',
            url: '/api/v1/classroom/command',
            headers,
            payload,
          });
          expect(adminResponse.statusCode).toBe(isAdmin ? 200 : 403);
          if (!isAdmin) {
            expect(adminResponse.json<unknown>()).toEqual({
              kind: 'failed',
              code: ClassroomFailure.FORBIDDEN,
            });
          }
        }
      }
    } finally {
      await api.close();
    }
  });
});

it('negotiates teaching organizations separately from existing admin metadata', async () => {
  const { api, store, schoolClass } = await createClassroomApi();
  const organizationId = randomUUID();
  store.classOrganizations.set(schoolClass.id, organizationId);
  store.organizationMemberships.set(`${organizationId}:teacher`, {
    organizationId,
    name: 'Teaching team',
    role: AccountRole.TEACHER,
  });
  try {
    const oldResponse = await api.inject({
      method: 'POST',
      url: '/api/v1/classroom/command',
      headers: { [ClassroomAdminCapability.HEADER]: ClassroomAdminCapability.VERSION },
      payload: { kind: 'home' },
    });
    expect(oldResponse.json<unknown>()).toMatchObject({ home: { isAdmin: false } });
    const olderAdminReplySchema = LegacyHomeReplySchema.extend({
      home: LegacyHomeReplySchema.shape.home.extend({ isAdmin: z.boolean() }),
    });
    expect(olderAdminReplySchema.safeParse(oldResponse.json<unknown>()).success).toBe(true);
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/classroom/command',
      headers: {
        [ClassroomAdminCapability.HEADER]: ClassroomAdminCapability.VERSION,
        [ClassroomOrganizationCapability.HEADER]: ClassroomOrganizationCapability.VERSION,
      },
      payload: { kind: 'home' },
    });
    expect(response.json<unknown>()).toMatchObject({
      home: {
        isAdmin: false,
        teachingOrganizations: [{ id: organizationId, name: 'Teaching team' }],
        classes: [{ canTeach: true }],
      },
    });
  } finally {
    await api.close();
  }
});
