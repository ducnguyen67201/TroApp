import { AccountRole } from '#contracts/AccountRole.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ClassroomService } from '../../../../src/server/features/classroom/application/ClassroomService.js';
import {
  ClassroomFailure,
  ClassroomPacing,
  ClassroomPhase,
  ClassroomStatus,
  type TeachingContext,
  type ClassroomReply,
  type ClassroomCommand,
} from '#contracts/Classroom.js';
import { createCourseContent, MemoryClassroomStore } from './ClassroomFixtures.js';

async function createClassroom(now?: () => Date) {
  const store = new MemoryClassroomStore();
  const service = new ClassroomService(store, now);
  const content = createCourseContent();
  const first = content.modules[0]?.lessons[0]?.activities[0];
  const second = content.modules[0]?.lessons[0]?.activities[1];
  if (!first || !second) {
    throw new Error('Missing fixture activities.');
  }
  const course = await store.saveCourse('teacher', 'Scratch', content);
  const schoolClass = await store.saveClass('teacher', 'Class A', course.id);
  await service.execute('teacher', {
    kind: 'start-session',
    classId: schoolClass.id,
    activityId: first.id,
    pacing: ClassroomPacing.TEACHER,
  });
  const meeting = (await store.listMeetings(schoolClass.id))[0];
  if (!meeting) {
    throw new Error('Missing fixture meeting.');
  }
  const join = async (studentId: string): Promise<TeachingContext> => {
    await store.enrollStudent(schoolClass.id, studentId, true);
    const reply = await service.execute(studentId, {
      kind: 'join',
      classSessionId: meeting.id,
      deviceId: randomUUID(),
    });
    if (reply.kind !== 'context') {
      throw new Error('Join failed.');
    }
    return reply.context;
  };
  return { store, service, schoolClass, first, second, meeting, join };
}

function binding(context: TeachingContext) {
  return {
    participationId: context.participation.id,
    deviceId: context.participation.deviceId,
    activityId: context.activity.id,
  };
}

function mutation(context: TeachingContext) {
  return {
    ...binding(context),
    contextVersion: context.meeting.contextVersion,
    progressVersion: context.attempt.progressVersion,
  };
}

function contextOf(reply: ClassroomReply): TeachingContext {
  if (reply.kind !== 'context') {
    throw new Error('Expected context.');
  }
  return reply.context;
}

describe('classroom business flow', () => {
  it('allows only the owning teacher to delete an inactive class and retains student history', async () => {
    const { service, store, schoolClass, meeting, join } = await createClassroom();
    const context = await join('student');
    const command = { kind: 'delete-class', classId: schoolClass.id } as const;
    for (const userId of ['student', 'other-teacher']) {
      await expect(service.execute(userId, command)).rejects.toMatchObject({
        code: ClassroomFailure.FORBIDDEN,
      });
    }
    await expect(service.execute('teacher', command)).rejects.toMatchObject({
      code: ClassroomFailure.STALE,
    });
    expect(await store.readClass(schoolClass.id)).not.toBeNull();
    await service.execute('teacher', {
      kind: 'end-session',
      classSessionId: meeting.id,
      contextVersion: meeting.contextVersion,
    });
    const invite = await service.execute('teacher', {
      kind: 'create-invitation',
      classId: schoolClass.id,
    });
    if (invite.kind !== 'invitation') {
      throw new Error('Invitation missing.');
    }
    const changed = vi.fn<(classId: string) => void>();
    service.subscribe(changed);
    await expect(service.execute('teacher', command)).resolves.toEqual({ kind: 'ok' });
    expect(changed).toHaveBeenCalledWith(schoolClass.id);
    expect(await store.readClass(schoolClass.id)).toBeNull();
    expect(await store.listClasses('teacher')).toEqual([]);
    expect(await store.listClasses('student')).toEqual([]);
    expect(await store.readParticipation(context.participation.id)).not.toBeNull();
    expect([...store.attempts.values()]).toContainEqual(context.attempt);
    await expect(
      service.execute('student', { kind: 'accept-invitation', code: invite.invitation.code }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
    await expect(
      service.execute('student', { kind: 'context', ...binding(context) }),
    ).rejects.toMatchObject({ code: ClassroomFailure.NOT_FOUND });
    await expect(
      service.execute('teacher', {
        kind: 'start-session',
        classId: schoolClass.id,
        activityId: context.activity.id,
        pacing: ClassroomPacing.TEACHER,
      }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  });

  it('requires enrollment and server-provisioned teacher identity; joining is explicit', async () => {
    const { service, store, meeting, schoolClass } = await createClassroom();
    await expect(
      service.execute('student', {
        kind: 'join',
        classSessionId: meeting.id,
        deviceId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
    await expect(
      service.execute('student', {
        kind: 'enroll',
        classId: schoolClass.id,
        email: 'student@example.test',
      }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
    await store.enrollStudent(schoolClass.id, 'student', true);
    expect(store.participations.size).toBe(0);
  });

  it('adds a student by email to their class list without joining them to the session', async () => {
    const { service, store, schoolClass } = await createClassroom();
    await service.execute('teacher', {
      kind: 'enroll',
      classId: schoolClass.id,
      email: 'student@example.test',
    });
    const reply = await service.execute('student', { kind: 'home' });
    if (reply.kind !== 'home') {
      throw new Error('Expected classroom home.');
    }
    expect(reply.home.classes.map((entry) => entry.schoolClass.id)).toContain(schoolClass.id);
    expect(store.participations.size).toBe(0);
  });

  it('keeps two students progress and working resources separate', async () => {
    const { service, join } = await createClassroom();
    const first = await join('first');
    const second = await join('second');
    const updated = contextOf(
      await service.execute('first', {
        kind: 'save-workspace',
        ...mutation(first),
        url: 'https://scratch.mit.edu/projects/123/',
      }),
    );
    expect(updated.attempt.workspaceUrl).toContain('/123/');
    const other = contextOf(
      await service.execute('second', { kind: 'context', ...binding(second) }),
    );
    expect(other.attempt.workspaceUrl).toBeNull();
    await expect(
      service.execute('second', { kind: 'context', ...binding(first) }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  });

  it('follows teacher sections, fences stale writes and preserves previous progress', async () => {
    const { service, join, meeting, second, first } = await createClassroom();
    const context = await join('student');
    const listener = vi.fn<(classId: string) => void>();
    const unsubscribe = service.subscribe(listener);
    await service.execute('teacher', {
      kind: 'update-session',
      classSessionId: meeting.id,
      contextVersion: 1,
      activityId: second.id,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.TEACHER,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    const moved = contextOf(
      await service.execute('student', { kind: 'context', ...binding(context) }),
    );
    expect(moved.activity.id).toBe(second.id);
    expect(moved.availableActivities).toHaveLength(1);
    await expect(
      service.execute('student', {
        kind: 'save-workspace',
        ...mutation(context),
        url: 'https://scratch.mit.edu/projects/123/',
      }),
    ).rejects.toMatchObject({ code: ClassroomFailure.STALE });
    await service.execute('teacher', {
      kind: 'update-session',
      classSessionId: meeting.id,
      contextVersion: 2,
      activityId: first.id,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.STUDENT,
    });
    const independent = contextOf(
      await service.execute('student', {
        kind: 'context',
        ...binding(context),
        activityId: second.id,
      }),
    );
    expect(independent.availableActivities).toHaveLength(2);
  });

  it('reconnects the same participation and rejects the old device after takeover', async () => {
    const { service, join, meeting } = await createClassroom();
    const old = await join('student');
    const current = contextOf(
      await service.execute('student', {
        kind: 'join',
        classSessionId: meeting.id,
        deviceId: randomUUID(),
      }),
    );
    expect(current.participation.id).toBe(old.participation.id);
    expect(current.attempt.id).toBe(old.attempt.id);
    await expect(
      service.execute('student', { kind: 'context', ...binding(old) }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  });

  it('accepts only canonical criterion reports and deduplicates progress retries', async () => {
    const { service, join } = await createClassroom();
    const context = await join('student');
    const command = {
      kind: 'report-progress' as const,
      ...mutation(context),
      eventId: randomUUID(),
      evidence: [],
      declaredComplete: true,
      helpSummary: '',
    };
    const first = contextOf(await service.execute('student', command));
    const retry = contextOf(await service.execute('student', command));
    expect(retry.attempt.progressVersion).toBe(first.attempt.progressVersion);
    await expect(
      service.execute('student', {
        ...command,
        eventId: randomUUID(),
        progressVersion: first.attempt.progressVersion,
        evidence: [
          { criterionId: randomUUID(), source: 'model', observation: 'Unknown criterion' },
        ],
      }),
    ).rejects.toMatchObject({ code: ClassroomFailure.INVALID });
  });

  it('prepares without submitting, returns one receipt on retry and refuses changed work', async () => {
    const { service, store, join } = await createClassroom();
    const context = contextOf(
      await service.execute('student', {
        kind: 'save-workspace',
        ...mutation(await join('student')),
        url: 'https://scratch.mit.edu/projects/123/',
      }),
    );
    const prepared = await service.execute('student', {
      kind: 'prepare-submission',
      ...mutation(context),
    });
    if (prepared.kind !== 'prepared') {
      throw new Error('Preparation failed.');
    }
    expect(store.submissions.size).toBe(0);
    const command = {
      kind: 'submit-work' as const,
      ...mutation(context),
      preparedSubmissionId: prepared.preparation.id,
      idempotencyKey: randomUUID(),
    };
    const receipt = await service.execute('student', command);
    expect(await service.execute('student', command)).toEqual(receipt);
    expect(store.submissions.size).toBe(1);
    const rejoined = await join('student');
    if (receipt.kind !== 'submitted') {
      throw new Error('Receipt is missing.');
    }
    expect(rejoined.latestSubmission).toEqual(receipt.receipt);
    await service.execute('student', {
      kind: 'save-workspace',
      ...mutation(rejoined),
      url: 'https://scratch.mit.edu/projects/456/',
    });
    await expect(
      service.execute('student', {
        ...command,
        ...mutation(rejoined),
        idempotencyKey: randomUUID(),
        progressVersion: context.attempt.progressVersion + 1,
      }),
    ).rejects.toMatchObject({ code: ClassroomFailure.STALE });
  });

  it('ends sessions and revokes enrollment without deleting projects or submissions', async () => {
    const { service, store, join, meeting, schoolClass } = await createClassroom();
    const context = await join('student');
    await service.execute('teacher', {
      kind: 'revoke',
      classId: schoolClass.id,
      studentId: 'student',
    });
    await expect(
      service.execute('student', { kind: 'context', ...binding(context) }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
    expect(store.attempts.size).toBe(1);
    await service.execute('teacher', {
      kind: 'end-session',
      classSessionId: meeting.id,
      contextVersion: 1,
    });
    await expect(
      service.execute('student', {
        kind: 'join',
        classSessionId: meeting.id,
        deviceId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: ClassroomFailure.STALE });
  });
});

it('reads durable roles on every request; owning a class alone does not grant teacher permission', async () => {
  const { store, service, schoolClass } = await createClassroom();
  expect(await service.execute('student', { kind: 'home' })).toMatchObject({
    kind: 'home',
    home: { role: AccountRole.STUDENT },
  });
  store.roles.set('teacher', AccountRole.STUDENT);
  await expect(
    service.execute('teacher', { kind: 'create-invitation', classId: schoolClass.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
});

it('enrolls verified students by code without starting a session or changing account roles', async () => {
  const { store, service, schoolClass } = await createClassroom();
  const created = await service.execute('teacher', {
    kind: 'create-invitation',
    classId: schoolClass.id,
  });
  if (created.kind !== 'invitation') {
    throw new Error('Invitation is missing.');
  }
  expect(JSON.stringify([...store.invitations.values()])).not.toContain(created.invitation.code);
  await service.execute('student', { kind: 'accept-invitation', code: created.invitation.code });
  await service.execute('student', { kind: 'accept-invitation', code: created.invitation.code });
  expect(await store.isEnrolled(schoolClass.id, 'student')).toBe(true);
  expect(store.participations.size).toBe(0);
  expect(await store.readAccountRole('student')).toBe(AccountRole.STUDENT);
  await expect(
    service.execute('student', { kind: 'create-invitation', classId: schoolClass.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
});

it('enforces invitation email, verification, expiry and teacher revocation', async () => {
  const now = vi.fn<() => Date>().mockReturnValue(new Date('2026-10-03T00:00:00Z'));
  const { store, service, schoolClass } = await createClassroom(now);
  const reply = await service.execute('teacher', {
    kind: 'create-invitation',
    classId: schoolClass.id,
    email: 'student@example.test',
  });
  if (reply.kind !== 'invitation') {
    throw new Error('Invitation is missing.');
  }
  const command = { kind: 'accept-invitation' as const, code: reply.invitation.code };
  await expect(service.execute('other', command)).rejects.toMatchObject({
    code: ClassroomFailure.FORBIDDEN,
  });
  store.emails.set('student', null);
  await expect(service.execute('student', command)).rejects.toMatchObject({
    code: ClassroomFailure.FORBIDDEN,
  });
  store.emails.set('student', 'student@example.test');
  await service.execute('student', command);
  now.mockReturnValue(new Date('2026-10-11T00:00:00Z'));
  await expect(service.execute('student', command)).rejects.toMatchObject({
    code: ClassroomFailure.FORBIDDEN,
  });
  now.mockReturnValue(new Date('2026-10-03T00:00:00Z'));
  await service.execute('teacher', { kind: 'revoke-invitations', classId: schoolClass.id });
  await expect(service.execute('student', command)).rejects.toMatchObject({
    code: ClassroomFailure.FORBIDDEN,
  });
});

describe('durable classroom participation', () => {
  it('restores expired participation and saved work on a new device while fencing the old device', async () => {
    let now = new Date();
    const { store, service, join } = await createClassroom(() => now);
    const context = await join('student');
    const saved = contextOf(
      await service.execute('student', {
        kind: 'save-workspace',
        ...mutation(context),
        url: 'https://scratch.mit.edu/projects/123/',
      }),
    );
    now = new Date(now.getTime() + 120_000);
    const restarted = new ClassroomService(store, () => now);
    const resumed = contextOf(
      await restarted.execute('student', {
        kind: 'resume',
        deviceId: randomUUID(),
      }),
    );
    expect(resumed.participation.id).toBe(context.participation.id);
    expect(resumed.attempt).toEqual(saved.attempt);
    expect(Date.parse(resumed.participation.leaseUntil)).toBeGreaterThan(now.getTime());
    await expect(
      service.execute('student', { kind: 'context', ...binding(context) }),
    ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
    expect(
      await restarted.execute('another-student', { kind: 'resume', deviceId: randomUUID() }),
    ).toEqual({ kind: 'ok' });
  });

  it.each(['leave', 'end-session', 'revoke'] as const)(
    'does not restore after %s',
    async (action) => {
      const { service, join, meeting, schoolClass } = await createClassroom();
      const context = await join('student');
      if (action === 'leave') {
        await service.execute('student', {
          kind: 'leave',
          participationId: context.participation.id,
          deviceId: context.participation.deviceId,
        });
      } else if (action === 'end-session') {
        await service.execute('teacher', {
          kind: 'end-session',
          classSessionId: meeting.id,
          contextVersion: meeting.contextVersion,
        });
      } else {
        await service.execute('teacher', {
          kind: 'revoke',
          classId: schoolClass.id,
          studentId: 'student',
        });
      }
      expect(await service.execute('student', { kind: 'resume', deviceId: randomUUID() })).toEqual({
        kind: 'ok',
      });
    },
  );
});

describe('admin classroom browsing', () => {
  it.each([AccountRole.STUDENT, AccountRole.TEACHER])(
    'lets a %s admin view another class without joining or changing ordinary class access',
    async (role) => {
      const { service, store, schoolClass, meeting, join } = await createClassroom();
      const context = await join('student');
      store.admins.add('admin');
      store.roles.set('admin', role);
      store.names.set('teacher', 'Class Teacher');
      store.rosters.set(meeting.id, [
        {
          studentId: 'student',
          name: 'Student',
          participation: context.participation,
          attempts: [context.attempt],
          submissions: [],
        },
      ]);
      const before = {
        classes: [...store.classes.values()],
        enrollments: [...store.enrollments],
        participations: [...store.participations.values()],
        attempts: [...store.attempts.values()],
      };
      await expect(service.execute('admin', { kind: 'admin-classes', offset: 0 })).resolves.toEqual(
        {
          kind: 'admin-classes',
          classes: [
            { schoolClass, teacherName: 'Class Teacher', teacherEmail: 'teacher@example.test' },
          ],
          hasMore: false,
        },
      );
      await expect(
        service.execute('admin', { kind: 'admin-class', classId: schoolClass.id }),
      ).resolves.toMatchObject({
        kind: 'admin-class',
        schoolClass,
        course: { id: schoolClass.courseRevisionId },
        meetings: [meeting],
        rosters: [
          {
            classSessionId: meeting.id,
            students: [{ studentId: 'student', attempts: [context.attempt] }],
          },
        ],
      });
      await expect(service.execute('admin', { kind: 'home' })).resolves.toEqual({
        kind: 'home',
        home: { role, isAdmin: true, courses: [], classes: [] },
      });
      expect({
        classes: [...store.classes.values()],
        enrollments: [...store.enrollments],
        participations: [...store.participations.values()],
        attempts: [...store.attempts.values()],
      }).toEqual(before);
    },
  );

  it('requires the current persisted admin flag on every list and detail request', async () => {
    const { service, store, schoolClass } = await createClassroom();
    const commands: ClassroomCommand[] = [
      { kind: 'admin-classes', offset: 0 },
      { kind: 'admin-class', classId: schoolClass.id },
    ];
    for (const userId of ['student', 'teacher', 'missing-user']) {
      for (const command of commands) {
        await expect(service.execute(userId, command)).rejects.toMatchObject({
          code: ClassroomFailure.FORBIDDEN,
        });
      }
    }
    store.admins.add('admin');
    await expect(
      service.execute('admin', { kind: 'admin-classes', offset: 0 }),
    ).resolves.toMatchObject({ kind: 'admin-classes' });
    store.admins.delete('admin');
    for (const command of commands) {
      await expect(service.execute('admin', command)).rejects.toMatchObject({
        code: ClassroomFailure.FORBIDDEN,
      });
    }
    await expect(service.execute('admin', { kind: 'home' })).resolves.toMatchObject({
      home: { isAdmin: false },
    });
  });

  it('does not grant an admin the owner or student authority needed by ordinary commands', async () => {
    const { service, store, schoolClass, meeting, first, join } = await createClassroom();
    const studentContext = await join('student');
    store.admins.add('admin');
    store.roles.set('admin', AccountRole.TEACHER);
    const commands: ClassroomCommand[] = [
      { kind: 'delete-class', classId: schoolClass.id },
      { kind: 'enroll', classId: schoolClass.id, email: 'new-student@example.test' },
      { kind: 'revoke', classId: schoolClass.id, studentId: 'student' },
      { kind: 'create-invitation', classId: schoolClass.id },
      { kind: 'revoke-invitations', classId: schoolClass.id },
      {
        kind: 'start-session',
        classId: schoolClass.id,
        activityId: first.id,
        pacing: ClassroomPacing.TEACHER,
      },
      {
        kind: 'update-session',
        classSessionId: meeting.id,
        contextVersion: meeting.contextVersion,
        activityId: first.id,
        phase: ClassroomPhase.PRACTICE,
        pacing: ClassroomPacing.TEACHER,
      },
      { kind: 'end-session', classSessionId: meeting.id, contextVersion: meeting.contextVersion },
      { kind: 'session-roster', classSessionId: meeting.id },
      { kind: 'join', classSessionId: meeting.id, deviceId: randomUUID() },
      { kind: 'context', ...binding(studentContext) },
      {
        kind: 'save-workspace',
        ...mutation(studentContext),
        url: 'https://scratch.mit.edu/projects/123/',
      },
    ];
    for (const command of commands) {
      await expect(service.execute('admin', command)).rejects.toMatchObject({
        code: ClassroomFailure.FORBIDDEN,
      });
    }
    expect(store.participations.size).toBe(1);
    expect(await store.readClass(schoolClass.id)).toEqual(schoolClass);
    expect(await store.isEnrolled(schoolClass.id, 'admin')).toBe(false);
    expect(await store.isEnrolled(schoolClass.id, 'student')).toBe(true);
  });

  it('loads only the requested or live session roster and rejects a session from another class', async () => {
    const { service, store, schoolClass, meeting } = await createClassroom();
    store.admins.add('admin');
    const olderMeeting = { ...meeting, id: randomUUID(), status: ClassroomStatus.ENDED };
    await store.saveMeeting(olderMeeting);
    const otherClass = await store.saveClass(
      'teacher',
      'Other class',
      schoolClass.courseRevisionId,
    );
    const otherMeeting = { ...meeting, id: randomUUID(), classId: otherClass.id };
    await store.saveMeeting(otherMeeting);
    const readRoster = vi.spyOn(store, 'readRoster');
    const current = await service.execute('admin', {
      kind: 'admin-class',
      classId: schoolClass.id,
    });
    expect(current).toMatchObject({
      kind: 'admin-class',
      meetings: [meeting, olderMeeting],
      rosters: [{ classSessionId: meeting.id, students: [] }],
    });
    expect(readRoster).toHaveBeenCalledExactlyOnceWith(meeting.id, schoolClass.id);
    readRoster.mockClear();
    expect(
      await service.execute('admin', {
        kind: 'admin-class',
        classId: schoolClass.id,
        classSessionId: olderMeeting.id,
      }),
    ).toMatchObject({
      kind: 'admin-class',
      rosters: [{ classSessionId: olderMeeting.id, students: [] }],
    });
    expect(readRoster).toHaveBeenCalledExactlyOnceWith(olderMeeting.id, schoolClass.id);
    for (const classSessionId of [otherMeeting.id, randomUUID()]) {
      await expect(
        service.execute('admin', { kind: 'admin-class', classId: schoolClass.id, classSessionId }),
      ).rejects.toMatchObject({ code: ClassroomFailure.NOT_FOUND });
    }
  });

  it('does not expose deleted classes or details for a missing class', async () => {
    const { service, store, schoolClass } = await createClassroom();
    store.admins.add('admin');
    await store.deleteClass(schoolClass.id);
    await expect(service.execute('admin', { kind: 'admin-classes', offset: 0 })).resolves.toEqual({
      kind: 'admin-classes',
      classes: [],
      hasMore: false,
    });
    for (const classId of [schoolClass.id, randomUUID()]) {
      await expect(
        service.execute('admin', { kind: 'admin-class', classId }),
      ).rejects.toMatchObject({ code: ClassroomFailure.NOT_FOUND });
    }
  });
});
