import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { createPrismaClassroomInsightStore } from '../../../src/server/persistence/PrismaClassroomInsightStore.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';
import { InsightRecordKind, type InsightRecord } from '#contracts/ClassroomInsights.js';

const environment = readServerEnv(process.env);
const classrooms = createPrismaClassroomStore(environment.DATABASE_URL);
const insights = createPrismaClassroomInsightStore(environment.DATABASE_URL);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});
afterAll(async () => {
  await classrooms.close();
  await insights.close();
  await client.$disconnect();
});
const window = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-31T00:00:00.000Z',
  timezone: 'UTC',
};

async function fixture() {
  const teacherId = randomUUID(),
    studentId = randomUUID();
  await client.user.createMany({
    data: [teacherId, studentId].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      role: id === teacherId ? 'teacher' : 'student',
    })),
  });
  const course = await classrooms.store.saveCourse(teacherId, 'Course', createCourseContent());
  const group = await classrooms.store.saveClass(teacherId, 'Group', course.id);
  await classrooms.store.enrollStudent(group.id, studentId, true);
  const activity = course.content.modules[0]?.lessons[0]?.activities[0];
  if (!activity) {
    throw new Error('Missing fixture activity.');
  }
  const record: InsightRecord = {
    kind: InsightRecordKind.PLAN,
    value: {
      id: randomUUID(),
      version: 1,
      sourceRevision: '0',
      courseRevisionId: course.id,
      classSessionId: null,
      title: 'Assigned task',
      activityIds: [activity.id],
      studentIds: [studentId],
      completionRule: 'hand_in',
      approvedBy: teacherId,
      approvedAt: '2026-10-08T12:00:00.000Z',
    },
  };
  return { classId: group.id, studentId, teacherId, record };
}

it('rolls back revision, event and record together and pins an older cutoff', async () => {
  const data = await fixture();
  const input = {
    classId: data.classId,
    actorId: data.teacherId,
    sourceId: randomUUID(),
    imported: false,
    recordedAt: '2026-10-08T12:00:00.000Z',
    record: data.record,
    expectedVersion: 0,
  };
  await expect(
    insights.store.runAtomically(async (store) => {
      await store.appendRecord(input);
      throw new Error('Abort');
    }),
  ).rejects.toThrow('Abort');
  expect((await insights.store.readPacket(data.classId, window)).sourceRevision).toBe('0');
  const first = await insights.store.appendRecord(input);
  if (first.kind !== InsightRecordKind.PLAN) {
    throw new Error('Wrong fixture record kind.');
  }
  await insights.store.appendRecord({
    ...input,
    sourceId: randomUUID(),
    expectedVersion: 1,
    record: { ...first, value: { ...first.value, version: 2 } },
  });
  const frozen = await insights.store.readPacket(data.classId, window, first.value.sourceRevision);
  expect(frozen.plans[0]?.version).toBe(1);
  expect((await insights.store.readPacket(data.classId, window)).plans[0]?.version).toBe(2);
});

it('refuses a stale concurrent version rather than overwriting another teacher change', async () => {
  const data = await fixture();
  const input = {
    classId: data.classId,
    actorId: data.teacherId,
    imported: false,
    recordedAt: '2026-10-08T12:00:00.000Z',
    record: data.record,
    expectedVersion: 0,
  };
  const outcomes = await Promise.allSettled([
    insights.store.appendRecord({ ...input, sourceId: randomUUID() }),
    insights.store.appendRecord({ ...input, sourceId: randomUUID() }),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await insights.store.readSourcePage(data.classId, window, '1', undefined, 50)).events,
  ).toHaveLength(1);
});

it('reads every source beyond the old twenty-row limit and removal defeats a frozen cutoff', async () => {
  const data = await fixture();
  for (let index = 0; index < 55; index += 1) {
    await insights.store.appendRecord({
      classId: data.classId,
      actorId: data.teacherId,
      sourceId: randomUUID(),
      imported: false,
      recordedAt: '2026-10-08T12:00:00.000Z',
      expectedVersion: 0,
      record: {
        kind: InsightRecordKind.NEXT_TASK,
        value: {
          id: randomUUID(),
          version: 1,
          sourceRevision: '0',
          studentId: data.studentId,
          activityId: data.record.value.activityIds[0] ?? randomUUID(),
          courseRevisionId: data.record.value.courseRevisionId,
          selectedBy: data.teacherId,
          selectedAt: '2026-10-08T12:00:00.000Z',
          sourceIds: [],
        },
      },
    });
  }
  const first = await insights.store.readSourcePage(data.classId, window, '55', undefined, 50);
  const second = await insights.store.readSourcePage(
    data.classId,
    window,
    '55',
    first.nextCursor ?? undefined,
    50,
  );
  expect(first.events.length + second.events.length).toBe(55);
  expect((await insights.store.readPacket(data.classId, window)).nextTasks).toHaveLength(55);
  await insights.store.removeStudentSources(
    data.classId,
    data.studentId,
    data.teacherId,
    '2026-10-08T13:00:00.000Z',
  );
  const frozen = await insights.store.readPacket(data.classId, window, '55');
  expect(frozen.nextTasks).toHaveLength(0);
  expect(frozen.removedStudentIds).toContain(data.studentId);
});

it('preserves pre-upgrade rows and imports legacy hand-ins without invented assignments', async () => {
  const data = await fixture();
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2026-10-09'),
    },
  });
  const attempt = await client.classroomAttempt.create({
    data: { id: randomUUID(), participationId: participation.id, activityId, evidence: [] },
  });
  const receipt = await client.classroomSubmission.create({
    data: {
      id: randomUUID(),
      attemptId: attempt.id,
      idempotencyKey: randomUUID(),
      url: 'https://scratch.mit.edu/projects/123/',
      submittedAt: new Date('2026-10-08T12:00:00.000Z'),
    },
  });
  const { importClassroomLearning } =
    await import('../../../src/server/persistence/ImportClassroomLearning.js');
  await client.$transaction((transaction) =>
    importClassroomLearning(transaction, data.classId, false),
  );
  expect((await insights.store.readPacket(data.classId, window)).submissions).toHaveLength(0);
  await client.$transaction((transaction) =>
    importClassroomLearning(transaction, data.classId, true),
  );
  await client.$transaction((transaction) =>
    importClassroomLearning(transaction, data.classId, true),
  );
  const packet = await insights.store.readPacket(data.classId, window);
  expect(packet.submissions).toHaveLength(1);
  expect(packet.submissions[0]?.courseRevisionId).toBeNull();
  expect(packet.plans).toHaveLength(0);
  expect(packet.coverage.status).toBe('partial');
  expect(await client.classroomSubmission.findUnique({ where: { id: receipt.id } })).not.toBeNull();
  await insights.store.removeStudentSources(
    data.classId,
    data.studentId,
    data.teacherId,
    '2026-10-08T13:00:00.000Z',
  );
  // Restored legacy content is scrubbed again; the durable tombstone prevents reimport.
  await client.classroomSubmission.create({ data: { ...receipt } });
  await client.$transaction((transaction) =>
    importClassroomLearning(transaction, data.classId, true),
  );
  expect((await insights.store.readPacket(data.classId, window)).submissions).toHaveLength(0);
  await insights.store.removeStudentSources(
    data.classId,
    data.studentId,
    data.teacherId,
    '2026-10-08T14:00:00.000Z',
  );
  expect(await client.classroomSubmission.findUnique({ where: { id: receipt.id } })).toBeNull();
});

it('captures admission and terminal result in their source transaction with stable episode order', async () => {
  const data = await fixture();
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2026-10-09'),
    },
  });
  const attempt = await client.classroomAttempt.create({
    data: { id: randomUUID(), participationId: participation.id, activityId, evidence: [] },
  });
  const { createPrismaPracticeCheckStore } =
    await import('../../../src/server/persistence/PrismaPracticeCheckStore.js');
  const { createPracticeCheckpoint } = await import('../features/classroom/PracticeFixtures.js');
  const { PracticeRecordSchema, PracticeCheckStatus } = await import('#contracts/PracticeCheck.js');
  const { createHash } = await import('node:crypto');
  const practice = createPrismaPracticeCheckStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
  });
  const evidenceId = randomUUID(),
    text = 'Hello';
  const record = PracticeRecordSchema.parse({
    id: randomUUID(),
    requestId: randomUUID(),
    snapshotId: randomUUID(),
    attemptId: attempt.id,
    checkpointId: randomUUID(),
    rubric: createPracticeCheckpoint(),
    status: PracticeCheckStatus.RUNNING,
    finding: null,
    results: [],
    evaluator: 'fixture-v1',
    createdAt: '2026-10-08T12:00:00.000Z',
    completedAt: null,
    evidence: [
      {
        id: evidenceId,
        kind: 'text',
        name: 'code',
        byteCount: Buffer.byteLength(text),
        digest: createHash('sha256').update(text).digest('hex'),
      },
    ],
  });
  const evidence = [{ id: evidenceId, kind: 'text' as const, name: 'code', text }];
  try {
    await expect(
      practice.store.runAtomically(async (store) => {
        await store.createCheck(
          data.studentId,
          data.record.value.courseRevisionId,
          'a'.repeat(64),
          record,
          evidence,
        );
        throw new Error('Abort source');
      }),
    ).rejects.toThrow('Abort source');
    expect(
      await client.classroomWorkSnapshot.findUnique({ where: { id: record.snapshotId } }),
    ).toBeNull();
    expect((await insights.store.readPacket(data.classId, window)).assessments).toHaveLength(0);
    await practice.store.createCheck(
      data.studentId,
      data.record.value.courseRevisionId,
      'a'.repeat(64),
      record,
      evidence,
    );
    const completed = {
      ...record,
      status: PracticeCheckStatus.COMPLETED,
      completedAt: '2026-10-08T12:01:00.000Z',
    };
    expect(await practice.store.finishCheck(completed)).toBe(true);
    expect(await practice.store.finishCheck(completed)).toBe(false);
    const packet = await insights.store.readPacket(data.classId, window);
    expect(packet.assessments).toHaveLength(1);
    expect(packet.assessments[0]?.version).toBe(2);
    expect(packet.assessments[0]?.episodeOrder).toBe(0);
    const page = await insights.store.readSourcePage(
      data.classId,
      window,
      packet.sourceRevision,
      undefined,
      50,
    );
    expect(
      page.events.flatMap((event) =>
        event.record.kind === InsightRecordKind.ASSESSMENT ? [event.record.value.status] : [],
      ),
    ).toEqual([PracticeCheckStatus.RUNNING, PracticeCheckStatus.COMPLETED]);
    await insights.store.removeStudentSources(
      data.classId,
      data.studentId,
      data.teacherId,
      '2026-10-08T13:00:00.000Z',
    );
    expect(await practice.store.readCheck(record.id)).toBeNull();
    expect(await practice.store.readEvidence(record.snapshotId)).toEqual([]);
    expect(
      await client.classroomPracticeEvidence.count({ where: { snapshotId: record.snapshotId } }),
    ).toBe(0);
  } finally {
    await practice.close();
  }
});

it('expires old content under explicit policy and never reimports a restored retired receipt', async () => {
  const data = await fixture();
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2026-10-09'),
    },
  });
  const attempt = await client.classroomAttempt.create({
    data: {
      id: randomUUID(),
      participationId: participation.id,
      activityId,
      evidence: [],
      workspaceUrl: 'https://scratch.mit.edu/projects/123/',
    },
  });
  const receipt = await client.classroomSubmission.create({
    data: {
      id: randomUUID(),
      attemptId: attempt.id,
      idempotencyKey: randomUUID(),
      url: 'https://scratch.mit.edu/projects/123/',
      submittedAt: new Date('2026-10-08T12:00:00.000Z'),
    },
  });
  const { importClassroomLearning } =
    await import('../../../src/server/persistence/ImportClassroomLearning.js');
  await client.$transaction((transaction) =>
    importClassroomLearning(transaction, data.classId, true),
  );
  const policyStore = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
    collectionPolicy: 'test-approved',
    retentionDays: 30,
  });
  try {
    const result = await policyStore.purgeExpiredSources(new Date('2027-01-08T12:00:00.000Z'), 30);
    expect(result.expired).toBeGreaterThan(0);
    expect(await client.classroomSubmission.findUnique({ where: { id: receipt.id } })).toBeNull();
    expect(
      (await client.classroomAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).workspaceUrl,
    ).toBeNull();
    await client.classroomSubmission.create({ data: { ...receipt } });
    await client.$transaction((transaction) =>
      importClassroomLearning(transaction, data.classId, true),
    );
    expect((await insights.store.readPacket(data.classId, window)).submissions).toHaveLength(0);
    expect(await classrooms.store.readLatestSubmission(attempt.id)).toBeNull();
    await policyStore.purgeExpiredSources(new Date('2027-01-08T12:00:00.000Z'), 30);
    expect(await client.classroomSubmission.findUnique({ where: { id: receipt.id } })).toBeNull();
  } finally {
    await policyStore.close();
  }
});

it('expires dated current work while preserving genuinely undated legacy work for operator review', async () => {
  const data = await fixture();
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2026-10-09'),
    },
  });
  const dated = await client.classroomAttempt.create({
    data: {
      id: randomUUID(),
      participationId: participation.id,
      activityId,
      evidence: [],
      workspaceUrl: 'https://scratch.mit.edu/projects/123/',
      lastSavedAt: new Date('2026-10-08'),
    },
  });
  const legacy = await client.classroomAttempt.create({
    data: {
      id: randomUUID(),
      participationId: participation.id,
      activityId: randomUUID(),
      evidence: [],
      workspaceUrl: 'https://scratch.mit.edu/projects/456/',
    },
  });
  const policyStore = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
  });
  try {
    await policyStore.purgeExpiredSources(new Date('2027-01-08'), 30);
    expect(
      (await client.classroomAttempt.findUniqueOrThrow({ where: { id: dated.id } })).workspaceUrl,
    ).toBeNull();
    expect(
      (await client.classroomAttempt.findUniqueOrThrow({ where: { id: legacy.id } })).workspaceUrl,
    ).toBe(legacy.workspaceUrl);
    expect((await insights.store.readPacket(data.classId, window)).coverage.reason).toContain(
      'unknown age',
    );
  } finally {
    await policyStore.close();
  }
});

it('scans one allowlisted class per expiry call and reports completion only after the full cycle', async () => {
  const groups = [await fixture(), await fixture()];
  const attemptIds: string[] = [];
  for (const data of groups) {
    const activityId = data.record.value.activityIds[0];
    if (!activityId) {
      throw new Error('Missing activity.');
    }
    const meeting = await client.classroomMeeting.create({
      data: {
        id: randomUUID(),
        classId: data.classId,
        status: 'live',
        phase: 'practice',
        pacing: 'teacher',
        currentActivityId: activityId,
      },
    });
    const participation = await client.classroomParticipation.create({
      data: {
        id: randomUUID(),
        classSessionId: meeting.id,
        studentId: data.studentId,
        deviceId: randomUUID(),
        leaseUntil: new Date('2026-10-09'),
      },
    });
    const attempt = await client.classroomAttempt.create({
      data: {
        id: randomUUID(),
        participationId: participation.id,
        activityId,
        evidence: [],
        workspaceUrl: 'https://scratch.mit.edu/projects/123/',
        lastSavedAt: new Date('2026-10-08'),
      },
    });
    attemptIds.push(attempt.id);
  }
  const policyStore = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
    captureClassIds: groups.map((data) => data.classId),
  });
  try {
    expect((await policyStore.purgeExpiredSources(new Date('2027-01-08'), 30)).more).toBe(true);
    expect((await policyStore.purgeExpiredSources(new Date('2027-01-08'), 30)).more).toBe(false);
    const attempts = await client.classroomAttempt.findMany({ where: { id: { in: attemptIds } } });
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.workspaceUrl === null)).toBe(true);
  } finally {
    await policyStore.close();
  }
});

it('retains minimal assignment eligibility after work removal so historical denominators stay fixed', async () => {
  const data = await fixture();
  const saved = await insights.store.appendRecord({
    classId: data.classId,
    actorId: data.teacherId,
    sourceId: randomUUID(),
    imported: false,
    recordedAt: '2026-10-08T12:00:00.000Z',
    record: data.record,
    expectedVersion: 0,
  });
  await insights.store.removeStudentSources(
    data.classId,
    data.studentId,
    data.teacherId,
    '2026-10-08T13:00:00.000Z',
  );
  const historical = await insights.store.readPacket(
    data.classId,
    window,
    saved.value.sourceRevision,
  );
  expect(historical.plans[0]?.studentIds).toEqual([data.studentId]);
  expect(historical.removedStudentIds).toContain(data.studentId);
  const page = await insights.store.readSourcePage(
    data.classId,
    window,
    saved.value.sourceRevision,
    undefined,
    50,
  );
  const plan = page.events.find((event) => event.record.kind === InsightRecordKind.PLAN);
  expect(plan?.record.kind === InsightRecordKind.PLAN ? plan.record.value.studentIds : []).toEqual([
    data.studentId,
  ]);
});

it('preserves freshly saved current work when an older matching URL and progress event expire', async () => {
  const data = await fixture();
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2027-01-09'),
    },
  });
  const criterionId = randomUUID();
  const freshEvidence = [
    { criterionId, source: 'student' as const, observation: 'Fresh work observation' },
  ];
  const attempt = await client.classroomAttempt.create({
    data: {
      id: randomUUID(),
      participationId: participation.id,
      activityId,
      evidence: freshEvidence,
      helpSummary: 'Fresh assistance note',
      workspaceUrl: 'https://scratch.mit.edu/projects/123/',
      progressVersion: 7,
      lastSavedAt: new Date('2027-01-05'),
    },
  });
  const receipt = await client.classroomSubmission.create({
    data: {
      id: randomUUID(),
      attemptId: attempt.id,
      idempotencyKey: randomUUID(),
      url: 'https://scratch.mit.edu/projects/123/',
      submittedAt: new Date('2026-10-08'),
    },
  });
  await insights.store.appendRecord({
    classId: data.classId,
    actorId: data.studentId,
    sourceId: randomUUID(),
    imported: false,
    recordedAt: '2026-10-08T12:00:00.000Z',
    expectedVersion: 0,
    record: {
      kind: InsightRecordKind.PROGRESS,
      value: {
        id: randomUUID(),
        version: 1,
        sourceRevision: '0',
        studentId: data.studentId,
        classSessionId: meeting.id,
        activityId,
        progressVersion: 7,
        declaredComplete: false,
        evidence: [{ criterionId, source: 'student', observation: 'Older work observation' }],
        recordedAt: '2026-10-08T12:00:00.000Z',
      },
    },
  });
  const policyStore = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
  });
  try {
    await policyStore.purgeExpiredSources(new Date('2027-01-08'), 30);
    const current = await client.classroomAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(current.workspaceUrl).toBe(attempt.workspaceUrl);
    expect(current.evidence).toEqual(freshEvidence);
    expect(current.helpSummary).toBe('Fresh assistance note');
    expect(await client.classroomSubmission.findUnique({ where: { id: receipt.id } })).toBeNull();
    expect(
      (
        await insights.store.readSourcePage(
          data.classId,
          window,
          (await insights.store.readPacket(data.classId, window)).sourceRevision,
          undefined,
          50,
        )
      ).events.some((event) => event.record.kind === InsightRecordKind.PROGRESS),
    ).toBe(false);
  } finally {
    await policyStore.close();
  }
});

it('continues the last approved retention policy after collection is disabled and updates it only explicitly', async () => {
  const data = await fixture();
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2027-01-09'),
    },
  });
  const attempt = await client.classroomAttempt.create({
    data: {
      id: randomUUID(),
      participationId: participation.id,
      activityId,
      evidence: [],
      workspaceUrl: 'https://scratch.mit.edu/projects/123/',
      lastSavedAt: new Date('2026-10-08'),
    },
  });
  const enabled = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
    collectionPolicy: 'approved-thirty-days',
    retentionDays: 30,
  });
  try {
    await enabled.purgeExpiredSources(new Date('2026-10-09'));
  } finally {
    await enabled.close();
  }
  expect(
    (await client.classroomInsightState.findUniqueOrThrow({ where: { classId: data.classId } }))
      .retentionDays,
  ).toBe(30);
  const disabled = createPrismaClassroomInsightStore(
    environment.DATABASE_URL,
    { captureClassIds: [] },
    { resumeStoredRetentionPolicies: true },
  );
  try {
    let more: boolean;
    do {
      more = (await disabled.purgeExpiredSources(new Date('2026-11-15'))).more;
    } while (more);
    expect(
      (await client.classroomAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).workspaceUrl,
    ).toBeNull();
  } finally {
    await disabled.close();
  }
  await client.classroomAttempt.update({
    where: { id: attempt.id },
    data: {
      workspaceUrl: 'https://scratch.mit.edu/projects/456/',
      lastSavedAt: new Date('2026-11-12'),
    },
  });
  const changed = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
    collectionPolicy: 'approved-ninety-days',
    retentionDays: 90,
  });
  try {
    await changed.purgeExpiredSources(new Date('2026-11-15'));
  } finally {
    await changed.close();
  }
  const stored = await client.classroomInsightState.findUniqueOrThrow({
    where: { classId: data.classId },
  });
  expect(stored.retentionDays).toBe(90);
  expect(stored.collectionPolicy).toBe('approved-ninety-days');
  const resumed = createPrismaClassroomInsightStore(
    environment.DATABASE_URL,
    { captureClassIds: [] },
    { resumeStoredRetentionPolicies: true },
  );
  try {
    let more: boolean;
    do {
      more = (await resumed.purgeExpiredSources(new Date('2027-01-01'), 30)).more;
    } while (more);
    // Another currently configured policy's argument must not override this stored ninety-day policy.
    expect(
      (await client.classroomAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).workspaceUrl,
    ).toBe('https://scratch.mit.edu/projects/456/');
  } finally {
    await resumed.close();
  }
});

it('allocates new captured episodes above retained orders after earlier episodes expire', async () => {
  const data = await fixture();
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2027-01-09'),
    },
  });
  const attempt = await client.classroomAttempt.create({
    data: { id: randomUUID(), participationId: participation.id, activityId, evidence: [] },
  });
  const { createPrismaPracticeCheckStore } =
    await import('../../../src/server/persistence/PrismaPracticeCheckStore.js');
  const { createPracticeCheckpoint } = await import('../features/classroom/PracticeFixtures.js');
  const { PracticeRecordSchema, PracticeCheckStatus } = await import('#contracts/PracticeCheck.js');
  const { createHash } = await import('node:crypto');
  const practice = createPrismaPracticeCheckStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
  });
  const policyStore = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
  });
  const checkpoint = createPracticeCheckpoint();
  const createEpisode = async (createdAt: string) => {
    const evidenceId = randomUUID();
    const record = PracticeRecordSchema.parse({
      id: randomUUID(),
      requestId: randomUUID(),
      snapshotId: randomUUID(),
      attemptId: attempt.id,
      checkpointId: checkpoint.id,
      rubric: checkpoint,
      status: PracticeCheckStatus.RUNNING,
      finding: null,
      results: [],
      evaluator: 'fixture-v1',
      createdAt,
      completedAt: null,
      evidence: [
        {
          id: evidenceId,
          kind: 'text',
          name: 'code',
          byteCount: 5,
          digest: createHash('sha256').update('Hello').digest('hex'),
        },
      ],
    });
    await practice.store.createCheck(
      data.studentId,
      data.record.value.courseRevisionId,
      'a'.repeat(64),
      record,
      [{ id: evidenceId, kind: 'text', name: 'code', text: 'Hello' }],
    );
    return record;
  };
  try {
    for (let index = 0; index < 9; index += 1) {
      await createEpisode('2026-10-08T12:00:00.000Z');
    }
    const retained = await createEpisode('2027-01-05T12:00:00.000Z');
    await policyStore.purgeExpiredSources(new Date('2027-01-08'), 30);
    const fresh = await createEpisode('2027-01-06T12:00:00.000Z');
    const packet = await insights.store.readPacket(data.classId, {
      from: '2027-01-01T00:00:00.000Z',
      to: '2027-01-31T00:00:00.000Z',
      timezone: 'UTC',
    });
    expect(packet.assessments).toHaveLength(2);
    expect(
      packet.assessments.find((assessment) => assessment.checkId === retained.id)?.episodeOrder,
    ).toBe(9);
    expect(
      packet.assessments.find((assessment) => assessment.checkId === fresh.id)?.episodeOrder,
    ).toBe(10);
    await practice.store.finishCheck({
      ...fresh,
      status: PracticeCheckStatus.COMPLETED,
      completedAt: '2027-01-06T12:01:00.000Z',
    });
    const completed = await insights.store.readPacket(data.classId, {
      from: '2027-01-01T00:00:00.000Z',
      to: '2027-01-31T00:00:00.000Z',
      timezone: 'UTC',
    });
    expect(
      completed.assessments.find((assessment) => assessment.checkId === fresh.id)?.episodeOrder,
    ).toBe(10);
  } finally {
    await practice.close();
    await policyStore.close();
  }
});

it('pins live link hand-ins to their accepted course revision and counts them against the approved plan', async () => {
  const data = await fixture();
  await insights.store.appendRecord({
    classId: data.classId,
    actorId: data.teacherId,
    sourceId: randomUUID(),
    imported: false,
    recordedAt: '2026-10-08T12:00:00.000Z',
    record: data.record,
    expectedVersion: 0,
  });
  const activityId = data.record.value.activityIds[0];
  if (!activityId) {
    throw new Error('Missing activity.');
  }
  const meeting = await client.classroomMeeting.create({
    data: {
      id: randomUUID(),
      classId: data.classId,
      status: 'live',
      phase: 'practice',
      pacing: 'teacher',
      currentActivityId: activityId,
    },
  });
  const participation = await client.classroomParticipation.create({
    data: {
      id: randomUUID(),
      classSessionId: meeting.id,
      studentId: data.studentId,
      deviceId: randomUUID(),
      leaseUntil: new Date('2026-10-09'),
    },
  });
  const attempt = await client.classroomAttempt.create({
    data: { id: randomUUID(), participationId: participation.id, activityId, evidence: [] },
  });
  const collecting = createPrismaClassroomStore(environment.DATABASE_URL, {
    captureClassIds: [data.classId],
  });
  try {
    await collecting.store.saveSubmission(
      {
        id: randomUUID(),
        attemptId: attempt.id,
        url: 'https://scratch.mit.edu/projects/123/',
        submittedAt: '2026-10-08T12:01:00.000Z',
      },
      randomUUID(),
    );
  } finally {
    await collecting.close();
  }
  const packet = await insights.store.readPacket(data.classId, window);
  expect(packet.submissions[0]?.courseRevisionId).toBe(data.record.value.courseRevisionId);
  const { calculateStudentProgress } =
    await import('../../../src/server/features/classroom/domain/CalculateStudentProgress.js');
  const progress = calculateStudentProgress(packet, data.studentId);
  expect(progress.assigned).toBe(1);
  expect(progress.handedIn).toBe(1);
});

it('atomically invalidates retained reports on course and roster changes while collection is disabled', async () => {
  const data = await fixture();
  await insights.store.appendRecord({
    classId: data.classId,
    actorId: data.teacherId,
    sourceId: randomUUID(),
    imported: false,
    recordedAt: '2026-10-08T12:00:00.000Z',
    record: data.record,
    expectedVersion: 0,
  });
  const { ClassroomInsightService } =
    await import('../../../src/server/features/classroom/application/ClassroomInsightService.js');
  const { ReportStatus } = await import('#contracts/ClassroomInsights.js');
  const service = new ClassroomInsightService(
    insights.store,
    { captureClassIds: [data.classId] },
    () => new Date('2026-10-09T12:00:00.000Z'),
  );
  const reportId = randomUUID();
  const created = await service.execute(data.teacherId, {
    kind: 'create-parent-report',
    classId: data.classId,
    requestId: randomUUID(),
    id: reportId,
    studentId: data.studentId,
    window,
  });
  if (created.kind !== 'parent-report') {
    throw new Error('Missing report.');
  }
  const approved = await service.execute(data.teacherId, {
    kind: 'approve-parent-report',
    classId: data.classId,
    requestId: randomUUID(),
    id: reportId,
    expectedVersion: created.report.version,
  });
  if (approved.kind !== 'parent-report') {
    throw new Error('Missing approved report.');
  }
  expect(approved.report.status).toBe(ReportStatus.APPROVED);
  const nextCourse = await classrooms.store.saveCourse(
    data.teacherId,
    'Updated course',
    createCourseContent(),
  );
  const originalPrivacy = (await insights.store.readPacket(data.classId, window)).privacyRevision;
  await expect(
    classrooms.store.runAtomically(async (store) => {
      await store.updateClassCourse(data.classId, nextCourse.id);
      throw new Error('Abort course update');
    }),
  ).rejects.toThrow('Abort course update');
  expect((await classrooms.store.readClass(data.classId))?.courseRevisionId).toBe(
    data.record.value.courseRevisionId,
  );
  expect((await insights.store.readPacket(data.classId, window)).privacyRevision).toBe(
    originalPrivacy,
  );
  await classrooms.store.updateClassCourse(data.classId, nextCourse.id);
  const afterCourse = (await insights.store.readPacket(data.classId, window)).privacyRevision;
  expect(BigInt(afterCourse)).toBe(BigInt(originalPrivacy) + 1n);
  await classrooms.store.enrollStudent(data.classId, data.studentId, false);
  await classrooms.store.enrollStudent(data.classId, data.studentId, true);
  expect(BigInt((await insights.store.readPacket(data.classId, window)).privacyRevision)).toBe(
    BigInt(afterCourse) + 2n,
  );
  await expect(
    service.execute(data.teacherId, {
      kind: 'export-parent-report',
      classId: data.classId,
      requestId: randomUUID(),
      id: reportId,
      expectedVersion: approved.report.version,
    }),
  ).rejects.toMatchObject({ code: 'stale' });
});
