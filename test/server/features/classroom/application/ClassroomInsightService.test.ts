import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ClassroomPhase,
  ClassroomPacing,
  ClassroomStatus,
  SubmissionRequirement,
} from '#contracts/Classroom.js';
import {
  ClassroomInsightCommandSchema,
  InsightRecordKind,
  ReportStatus,
  type ClassroomInsightCommand,
  type ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';
import { ClassroomInsightService } from '../../../../../src/server/features/classroom/application/ClassroomInsightService.js';
import type {
  ClassroomInsightStore,
  InsightAccess,
} from '../../../../../src/server/features/classroom/application/ClassroomInsightStore.js';
import { buildParentReport } from '../../../../../src/server/features/classroom/domain/BuildParentReport.js';
import { calculateStudentProgress } from '../../../../../src/server/features/classroom/domain/CalculateStudentProgress.js';
import {
  createAssessment,
  createInsightPacket,
  insightId,
} from '../domain/ClassroomInsightFixtures.js';

function createStore() {
  const packet = createInsightPacket();
  const access: InsightAccess = {
    classId: packet.classId,
    teacherId: 'teacher',
    deleted: false,
    isTeacher: true,
    studentIds: ['child', 'other'],
    courseRevisionId: insightId(7),
    activities: [
      {
        id: insightId(3),
        title: 'Stop robot',
        objective: 'Explain stop condition',
        instructions: '',
        prerequisites: [],
        criteria: [{ id: insightId(9), description: 'Explain stop condition' }],
        materials: [],
        submission: SubmissionRequirement.NONE,
        practiceCheckpoints: [
          {
            id: insightId(40),
            rubricRevisionId: insightId(8),
            title: 'Stop',
            task: 'Explain stop',
            approved: true,
            origin: 'source',
            criteria: [
              {
                id: insightId(9),
                description: 'Explain the stop condition',
                required: true,
                evidenceNeeded: 'Explanation',
                sourceIds: [],
              },
            ],
          },
        ],
      },
    ],
  };
  const store = {
    async runAtomically<T>(work: (transaction: ClassroomInsightStore) => Promise<T>): Promise<T> {
      return work(store);
    },
    readAccess: vi.fn<ClassroomInsightStore['readAccess']>().mockResolvedValue(access),
    readClassSession: vi.fn<ClassroomInsightStore['readClassSession']>().mockResolvedValue({
      id: insightId(2),
      classId: packet.classId,
      status: ClassroomStatus.LIVE,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.TEACHER,
      currentActivityId: insightId(3),
      contextVersion: 1,
    }),
    readStudentAuthority: vi
      .fn<ClassroomInsightStore['readStudentAuthority']>()
      .mockResolvedValue(null),
    readPacket: vi.fn<ClassroomInsightStore['readPacket']>().mockResolvedValue(packet),
    readRecord: vi.fn<ClassroomInsightStore['readRecord']>().mockResolvedValue(null),
    readEvidence: vi.fn<ClassroomInsightStore['readEvidence']>().mockResolvedValue(null),
    appendRecord: vi
      .fn<ClassroomInsightStore['appendRecord']>()
      .mockImplementation((input) => Promise.resolve(input.record)),
    findReceipt: vi.fn<ClassroomInsightStore['findReceipt']>().mockResolvedValue(null),
    saveReceipt: vi.fn<ClassroomInsightStore['saveReceipt']>().mockResolvedValue(undefined),
    readSourcePage: vi
      .fn<ClassroomInsightStore['readSourcePage']>()
      .mockResolvedValue({ events: [], nextCursor: null }),
    removeStudentSources: vi
      .fn<ClassroomInsightStore['removeStudentSources']>()
      .mockResolvedValue('1'),
  } satisfies ClassroomInsightStore;
  const service = new ClassroomInsightService(
    store,
    { captureClassIds: [packet.classId] },
    () => new Date('2026-10-31T23:59:59Z'),
  );
  const report = buildParentReport(calculateStudentProgress(packet, 'child'), {
    id: insightId(500),
    createdBy: 'teacher',
    createdAt: '2026-10-31T23:59:59Z',
  });
  return { packet, access, store, service, report };
}

function createTeacherAssessmentCommand(): Extract<
  ClassroomInsightCommand,
  { kind: 'record-assessment' }
> {
  const assessment = createAssessment();
  return {
    kind: 'record-assessment',
    classId: insightId(1),
    id: insightId(503),
    requestId: insightId(501),
    studentId: assessment.studentId,
    classSessionId: assessment.classSessionId,
    activityId: assessment.activityId,
    episodeId: insightId(302),
    mappingId: insightId(20),
    mappingVersion: 1,
    taskVariantId: insightId(23),
    purpose: assessment.purpose,
    assistance: assessment.assistance,
    individual: true,
    unaidedConfirmed: true,
    observedAt: '2026-10-03T10:00:00Z',
    checkId: null,
    priorEpisodeId: null,
    supersedesId: null,
    results: assessment.results.map((result) => ({ ...result, evidenceIds: [] })),
    expectedVersion: 0,
  };
}

function digestCommand(command: ClassroomInsightCommand): string {
  return createHash('sha256')
    .update(JSON.stringify(ClassroomInsightCommandSchema.parse(command)))
    .digest('hex');
}

describe('ClassroomInsightService authorization and report integrity', () => {
  it('refuses unauthorized class access before reading student sources', async () => {
    const { store, service, packet } = createStore();
    vi.mocked(store.readAccess).mockResolvedValue(null);
    await expect(
      service.execute('outsider', { kind: 'status', classId: packet.classId }),
    ).rejects.toThrow('forbidden');
    expect(store.readPacket).not.toHaveBeenCalled();
  });

  it('limits students to their own history and refuses teacher-only class summaries', async () => {
    const { store, service, packet, access } = createStore();
    vi.mocked(store.readAccess).mockResolvedValue({ ...access, isTeacher: false });
    await expect(
      service.execute('child', {
        kind: 'read-class-insights',
        classId: packet.classId,
        window: packet.window,
      }),
    ).rejects.toThrow('forbidden');
    await expect(
      service.execute('child', {
        kind: 'read-student-progress',
        classId: packet.classId,
        studentId: 'other',
        window: packet.window,
      }),
    ).rejects.toThrow('forbidden');
    const reply = await service.execute('child', {
      kind: 'read-student-progress',
      classId: packet.classId,
      studentId: 'child',
      window: packet.window,
    });
    expect(reply.kind).toBe('student-progress');
    if (reply.kind !== 'student-progress') {
      throw new Error('Unexpected fixture reply');
    }
    expect(reply.progress.studentId).toBe('child');
    expect(reply.progress.assessments.every((record) => record.studentId === 'child')).toBe(true);
  });

  it('redacts unrelated assignment metadata from student status', async () => {
    const { store, service, packet, access } = createStore();
    packet.plans = packet.plans.map((plan) => ({ ...plan, studentIds: ['other'] }));
    vi.mocked(store.readAccess).mockResolvedValue({ ...access, isTeacher: false });
    const reply = await service.execute('child', { kind: 'status', classId: packet.classId });
    expect(reply.kind).toBe('status');
    if (reply.kind !== 'status') {
      throw new Error('Unexpected fixture reply');
    }
    expect(reply.students).toEqual([{ id: 'child', name: 'Mai' }]);
    expect(reply.plans).toEqual([]);
  });

  it('scopes assessment and evidence reads to the requested child and class', async () => {
    const { store, service, packet } = createStore();
    vi.mocked(store.readRecord).mockResolvedValue({
      kind: InsightRecordKind.ASSESSMENT,
      value: createAssessment({ studentId: 'other' }),
    });
    await expect(
      service.execute('teacher', {
        kind: 'read-evidence',
        classId: packet.classId,
        studentId: 'child',
        assessmentId: insightId(100),
      }),
    ).rejects.toThrow('forbidden');
    expect(store.readRecord).toHaveBeenCalledWith(
      packet.classId,
      InsightRecordKind.ASSESSMENT,
      insightId(100),
    );
    expect(store.readEvidence).not.toHaveBeenCalled();
  });

  it('replays a matching receipt without repeating writes and rejects conflicting digests', async () => {
    const { store, service, packet } = createStore();
    const command: ClassroomInsightCommand = {
      kind: 'remove-student-sources',
      classId: packet.classId,
      requestId: insightId(501),
      studentId: 'child',
      confirmation: 'remove-learning-history',
    };
    const reply: ClassroomInsightReply = { kind: 'removed', privacyRevision: '1' };
    vi.mocked(store.findReceipt).mockResolvedValue({ digest: digestCommand(command), reply });
    await expect(service.execute('teacher', command)).resolves.toEqual(reply);
    expect(store.removeStudentSources).not.toHaveBeenCalled();
    vi.mocked(store.findReceipt).mockResolvedValue({ digest: 'different', reply });
    await expect(service.execute('teacher', command)).rejects.toThrow('stale');
  });

  it('refuses stale report versions and privacy changes at approval and export', async () => {
    const { store, service, packet, report } = createStore();
    vi.mocked(store.readRecord).mockResolvedValue({
      kind: InsightRecordKind.REPORT,
      value: report,
    });
    const command: ClassroomInsightCommand = {
      kind: 'approve-parent-report',
      classId: packet.classId,
      id: report.id,
      requestId: insightId(501),
      expectedVersion: 2,
    };
    await expect(service.execute('teacher', command)).rejects.toThrow('stale');
    packet.privacyRevision = '1';
    await expect(service.execute('teacher', { ...command, expectedVersion: 1 })).rejects.toThrow(
      'stale',
    );
    vi.mocked(store.readRecord).mockResolvedValue({
      kind: InsightRecordKind.REPORT,
      value: {
        ...report,
        status: ReportStatus.APPROVED,
        approvedBy: 'teacher',
        approvedAt: report.createdAt,
      },
    });
    await expect(
      service.execute('teacher', {
        kind: 'export-parent-report',
        classId: packet.classId,
        id: report.id,
        requestId: insightId(502),
        expectedVersion: 1,
      }),
    ).rejects.toThrow('stale');
    expect(store.appendRecord).not.toHaveBeenCalled();
  });

  it('refuses approval after a referenced assessment correction without a privacy change', async () => {
    const { store, service, packet, report } = createStore();
    packet.sourceRevision = '120';
    packet.assessments = [createAssessment({ version: 2, sourceRevision: '110', results: [] })];
    vi.mocked(store.readRecord).mockResolvedValue({
      kind: InsightRecordKind.REPORT,
      value: report,
    });
    await expect(
      service.execute('teacher', {
        kind: 'approve-parent-report',
        classId: packet.classId,
        id: report.id,
        requestId: insightId(501),
        expectedVersion: 1,
      }),
    ).rejects.toThrow('stale');
    expect(store.appendRecord).not.toHaveBeenCalled();
  });

  it('keeps late teacher observations unordered and preserves known episode ordering', async () => {
    const { store, service, packet } = createStore();
    const command = createTeacherAssessmentCommand();
    const reply = await service.execute('teacher', {
      ...command,
      observedAt: '2026-10-01T10:00:00Z',
    });
    if (reply.kind !== 'saved' || reply.record.kind !== InsightRecordKind.ASSESSMENT) {
      throw new Error('Unexpected fixture reply');
    }
    expect(reply.record.value.episodeOrder).toBeNull();
    packet.assessments = [createAssessment({ episodeOrder: null })];
    const correction = await service.execute('teacher', {
      ...command,
      episodeId: insightId(4),
      observedAt: '2026-10-02T10:00:00Z',
      supersedesId: insightId(100),
    });
    if (correction.kind !== 'saved' || correction.record.kind !== InsightRecordKind.ASSESSMENT) {
      throw new Error('Unexpected fixture reply');
    }
    expect(correction.record.value.episodeOrder).toBeNull();
    expect(store.appendRecord).toHaveBeenCalledTimes(2);
  });

  it('refuses foreign session bindings for assessment and assignment writes', async () => {
    const { store, service, packet } = createStore();
    vi.mocked(store.readClassSession).mockResolvedValue(null);
    await expect(service.execute('teacher', createTeacherAssessmentCommand())).rejects.toThrow(
      'invalid',
    );
    await expect(
      service.execute('teacher', {
        kind: 'approve-plan',
        classId: packet.classId,
        id: insightId(504),
        requestId: insightId(501),
        expectedVersion: 0,
        classSessionId: insightId(2),
        courseRevisionId: insightId(7),
        title: 'Session assignment',
        activityIds: [insightId(3)],
        studentIds: ['child'],
      }),
    ).rejects.toThrow('invalid');
    expect(store.appendRecord).not.toHaveBeenCalled();
  });

  it('refuses mutations of deleted support records without reviving their contents', async () => {
    const { store, service, packet } = createStore();
    packet.removedStudentIds = ['child'];
    vi.mocked(store.readRecord).mockResolvedValue({
      kind: InsightRecordKind.SUPPORT,
      value: {
        id: insightId(504),
        version: 1,
        sourceRevision: '3',
        studentId: 'child',
        classSessionId: insightId(2),
        activityId: insightId(3),
        criterionId: null,
        requestedAt: '2026-10-02T10:00:00Z',
        category: 'Stop condition',
        interventions: [],
        closedAt: null,
        reportedOutcome: null,
        sourceIds: [insightId(504)],
      },
    });
    await expect(
      service.execute('teacher', {
        kind: 'record-support',
        classId: packet.classId,
        id: insightId(504),
        requestId: insightId(501),
        expectedVersion: 1,
        type: 'hint',
        note: 'Prompt',
      }),
    ).rejects.toThrow('removed');
    expect(store.appendRecord).not.toHaveBeenCalled();
  });

  it('refuses foreign evidence citations and mismatched correction episode scope', async () => {
    const { store, service } = createStore();
    const command = createTeacherAssessmentCommand();
    await expect(
      service.execute('teacher', {
        ...command,
        episodeId: insightId(4),
        observedAt: '2026-10-02T10:00:00Z',
        checkId: insightId(6),
        results: [
          {
            ...command.results[0],
            criterionId: insightId(9),
            finding: 'met',
            feedback: 'Checked',
            evidenceIds: [insightId(999)],
          },
        ],
      }),
    ).rejects.toThrow('invalid');
    await expect(
      service.execute('teacher', { ...command, supersedesId: insightId(100) }),
    ).rejects.toThrow('invalid');
    expect(store.appendRecord).not.toHaveBeenCalled();
  });

  it('pins a teacher correction to the original course, rubric, episode and provenance', async () => {
    const { service, packet } = createStore();
    const command = createTeacherAssessmentCommand();
    const original = packet.assessments[0];
    if (!original) {
      throw new Error('Fixture assessment missing');
    }
    const reply = await service.execute('teacher', {
      ...command,
      episodeId: original.episodeId,
      observedAt: original.observedAt,
      supersedesId: original.id,
    });
    if (reply.kind !== 'saved' || reply.record.kind !== InsightRecordKind.ASSESSMENT) {
      throw new Error('Unexpected fixture reply');
    }
    expect(reply.record.value).toMatchObject({
      courseRevisionId: original.courseRevisionId,
      rubricRevisionId: original.rubricRevisionId,
      episodeOrder: original.episodeOrder,
      snapshotId: original.snapshotId,
      supersedesId: original.id,
    });
    expect(reply.record.value.sourceIds).toContain(original.id);
  });

  it('pins the approved activity title when selecting the next task', async () => {
    const { service, packet } = createStore();
    const reply = await service.execute('teacher', {
      kind: 'select-next-task',
      classId: packet.classId,
      id: insightId(502),
      requestId: insightId(501),
      studentId: 'child',
      activityId: insightId(3),
      courseRevisionId: insightId(7),
      expectedVersion: 0,
    });
    if (reply.kind !== 'saved' || reply.record.kind !== InsightRecordKind.NEXT_TASK) {
      throw new Error('Unexpected fixture reply');
    }
    expect(reply.record.value.title).toBe('Stop robot');
  });

  it('does not replay saved student facts after a privacy removal', async () => {
    const { store, service, packet } = createStore();
    const command: ClassroomInsightCommand = {
      kind: 'select-next-task',
      classId: packet.classId,
      id: insightId(502),
      requestId: insightId(501),
      studentId: 'child',
      activityId: insightId(3),
      courseRevisionId: insightId(7),
      expectedVersion: 0,
    };
    const reply: ClassroomInsightReply = {
      kind: 'saved',
      record: { kind: InsightRecordKind.ASSESSMENT, value: createAssessment() },
    };
    vi.mocked(store.findReceipt).mockResolvedValue({ digest: digestCommand(command), reply });
    packet.removedStudentIds = ['child'];
    await expect(service.execute('teacher', command)).rejects.toThrow();
    expect(store.appendRecord).not.toHaveBeenCalled();
  });
});
