import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { createPrismaPracticeCheckStore } from '../../../src/server/persistence/PrismaPracticeCheckStore.js';
import { ClassroomService } from '../../../src/server/features/classroom/application/ClassroomService.js';
import { PracticeCheckService } from '../../../src/server/features/classroom/application/PracticeCheckService.js';
import type { PracticeCheckEvaluator } from '../../../src/server/features/classroom/application/PracticeCheckEvaluator.js';
import { ClassroomPacing, ClassroomPhase } from '#contracts/Classroom.js';
import type { PracticeCommand } from '#contracts/PracticeCheck.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';
import { createPracticeCheckpoint } from '../features/classroom/PracticeFixtures.js';
const environment = readServerEnv(process.env);
const classrooms = createPrismaClassroomStore(environment.DATABASE_URL),
  practice = createPrismaPracticeCheckStore(environment.DATABASE_URL);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});
afterAll(async () => {
  await classrooms.close();
  await practice.close();
  await client.$disconnect();
});

async function fixture() {
  const teacher = randomUUID(),
    student = randomUUID(),
    other = randomUUID();
  await client.user.createMany({
    data: [teacher, student, other].map((id) => ({
      id,
      email: `${id}@example.test`,
      name: id,
      role: id === teacher ? 'teacher' : 'student',
    })),
  });
  const content = createCourseContent(),
    activity = content.modules[0]?.lessons[0]?.activities[0];
  if (!activity) {
    throw new Error('Missing activity.');
  }
  const checkpoint = createPracticeCheckpoint();
  activity.practiceCheckpoints = [checkpoint];
  const course = await classrooms.store.saveCourse(teacher, 'Practice', content),
    schoolClass = await classrooms.store.saveClass(teacher, 'Practice', course.id);
  const classroom = new ClassroomService(classrooms.store);
  await classrooms.store.enrollStudent(schoolClass.id, student, true);
  await classroom.execute(teacher, {
    kind: 'start-session',
    classId: schoolClass.id,
    activityId: activity.id,
    pacing: ClassroomPacing.TEACHER,
  });
  const meeting = (await classrooms.store.listMeetings(schoolClass.id))[0];
  if (!meeting) {
    throw new Error('Missing meeting.');
  }
  await classroom.execute(teacher, {
    kind: 'update-session',
    classSessionId: meeting.id,
    contextVersion: meeting.contextVersion,
    activityId: activity.id,
    phase: ClassroomPhase.PRACTICE,
    pacing: ClassroomPacing.TEACHER,
  });
  const joined = await classroom.execute(student, {
    kind: 'join',
    classSessionId: meeting.id,
    deviceId: randomUUID(),
  });
  if (joined.kind !== 'context') {
    throw new Error('Join failed.');
  }
  const context = joined.context;
  const evaluate = vi
    .fn<PracticeCheckEvaluator['evaluate']>()
    .mockImplementation((rubric, evidence) =>
      Promise.resolve({
        results: rubric.criteria.map((criterion) => ({
          criterionId: criterion.id,
          finding: 'needs_changes',
          feedback: 'Improve the greeting',
          evidenceIds: evidence.map((item) => item.id),
        })),
      }),
    );
  const service = new PracticeCheckService(
    practice.store,
    { available: true, version: 'fake/v1', evaluate },
    { dailyChecks: 30, minuteChecks: 5 },
  );
  const command: Extract<PracticeCommand, { kind: 'check' }> = {
    kind: 'check',
    participationId: context.participation.id,
    deviceId: context.participation.deviceId,
    activityId: context.activity.id,
    contextVersion: context.meeting.contextVersion,
    progressVersion: context.attempt.progressVersion,
    checkpointId: checkpoint.id,
    requestId: randomUUID(),
    locale: 'en',
    evidence: [{ id: randomUUID(), kind: 'text', name: 'Work.py', text: 'print("Hi")' }],
  };
  return { teacher, student, other, context, command, service, evaluate, classroom };
}

it('persists snapshots, results and append-only hand-ins across connections with scoped reads', async () => {
  const { service, student, teacher, other, command } = await fixture();
  const result = await service.execute(student, command);
  if (result.kind !== 'check') {
    throw new Error('Missing check.');
  }
  expect(result.check.status).toBe('completed');
  expect(result.check.finding).toBe('needs_changes');
  const connection = createPrismaPracticeCheckStore(environment.DATABASE_URL);
  try {
    expect((await connection.store.readCheck(result.check.id))?.record).toEqual(result.check);
  } finally {
    await connection.close();
  }
  const submit: Extract<PracticeCommand, { kind: 'submit-snapshot' }> = {
    kind: 'submit-snapshot',
    participationId: command.participationId,
    deviceId: command.deviceId,
    activityId: command.activityId,
    contextVersion: command.contextVersion,
    progressVersion: command.progressVersion,
    checkId: result.check.id,
    requestId: randomUUID(),
  };
  const [first, retry] = await Promise.all([
    service.execute(student, submit),
    service.execute(student, submit),
  ]);
  expect(first).toEqual(retry);
  const [next, third] = await Promise.all([
    service.execute(student, { ...submit, requestId: randomUUID() }),
    service.execute(student, { ...submit, requestId: randomUUID() }),
  ]);
  expect(
    next.kind === 'submitted' &&
      third.kind === 'submitted' &&
      [next.submission.sequence, third.submission.sequence].sort(),
  ).toEqual([2, 3]);
  expect(await client.classroomWorkSubmission.count({ where: { checkId: result.check.id } })).toBe(
    3,
  );
  const replacement = await classrooms.store.saveCourse(
    teacher,
    'Next materials',
    createCourseContent(),
  );
  const attempt = await client.classroomAttempt.findUnique({
    where: { id: result.check.attemptId },
    include: { participation: { include: { meeting: true } } },
  });
  if (!attempt) {
    throw new Error('Missing attempt.');
  }
  await classrooms.store.updateClassCourse(attempt.participation.meeting.classId, replacement.id);
  expect(
    (await service.execute(student, { kind: 'read-evidence', checkId: result.check.id })).kind,
  ).toBe('evidence');
  expect(
    (await service.execute(teacher, { kind: 'read-evidence', checkId: result.check.id })).kind,
  ).toBe('evidence');
  await expect(
    service.execute(other, { kind: 'read-evidence', checkId: result.check.id }),
  ).rejects.toThrow('forbidden');
});
it('serializes concurrent duplicate admissions into one provider dispatch and one snapshot', async () => {
  const { service, student, command, evaluate } = await fixture();
  let finish: () => void = () => {};
  evaluate.mockImplementation(
    (rubric, evidence) =>
      new Promise((resolve) => {
        finish = () => {
          resolve({
            results: rubric.criteria.map((criterion) => ({
              criterionId: criterion.id,
              finding: 'met',
              feedback: 'Observed',
              evidenceIds: evidence.map((item) => item.id),
            })),
          });
        };
      }),
  );
  const first = service.execute(student, command);
  await vi.waitFor(() => {
    expect(evaluate).toHaveBeenCalledOnce();
  });
  const second = await service.execute(student, command);
  expect(second.kind === 'check' && second.check.status).toBe('running');
  finish();
  await first;
  expect(evaluate).toHaveBeenCalledOnce();
  expect(await client.classroomPracticeCheck.count({ where: { studentId: student } })).toBe(1);
});
it('rejects revoked membership and deleted class evidence after storage', async () => {
  const { service, student, teacher, command, context } = await fixture();
  const result = await service.execute(student, command);
  if (result.kind !== 'check') {
    throw new Error('Missing check.');
  }
  await classrooms.store.enrollStudent(context.meeting.classId, student, false);
  await expect(
    service.execute(student, { kind: 'read-evidence', checkId: result.check.id }),
  ).rejects.toThrow('forbidden');
  await client.classroomGroup.update({
    where: { id: context.meeting.classId },
    data: { deletedAt: new Date() },
  });
  await expect(
    service.execute(teacher, { kind: 'read-evidence', checkId: result.check.id }),
  ).rejects.toThrow('forbidden');
});
