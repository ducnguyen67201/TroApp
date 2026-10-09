import { describe, expect, it } from 'vitest';
import {
  AssistanceContext,
  AssessmentMethod,
  AssessmentPurpose,
  InsightClassSummarySchema,
  InsightStudentProgressSchema,
  type InsightSourcePacket,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus } from '#contracts/PracticeCheck.js';
import { calculateClassSummary } from '../../../../../src/server/features/classroom/domain/CalculateClassSummary.js';
import { calculateStudentProgress } from '../../../../../src/server/features/classroom/domain/CalculateStudentProgress.js';
import { createAssessment, createInsightPacket, insightId } from './ClassroomInsightFixtures.js';

/** Synthetic ledger fixtures prove completeness, not provider quality or operator performance. */
function createSixMonthClass(studentCount: number): InsightSourcePacket {
  const packet = createInsightPacket({
    window: { from: '2026-04-01T00:00:00Z', to: '2026-09-30T23:59:59Z', timezone: 'UTC' },
  });
  packet.coverage = { ...packet.coverage, captureStartedAt: packet.window.from };
  packet.mappings = packet.mappings.map((mapping) => ({
    ...mapping,
    approvedAt: packet.window.from,
  }));
  packet.students = Array.from({ length: studentCount }, (_, index) => ({
    id: index === 0 ? 'child' : `synthetic-student-${String(index)}`,
    name: `Synthetic ${String(index + 1)}`,
    enrolled: true,
  }));
  const plan = packet.plans[0];
  if (!plan) {
    throw new Error('Fixture plan missing');
  }
  const sessionIds = Array.from({ length: 6 }, (_, index) => insightId(1000 + index));
  const sessionTime = (index: number): string =>
    new Date(Date.UTC(2026, 3 + index, 2, 10)).toISOString();
  packet.plans = [
    {
      ...plan,
      approvedAt: packet.window.from,
      studentIds: packet.students.map((student) => student.id),
    },
    ...sessionIds.map((classSessionId, index) => ({
      ...plan,
      id: insightId(2000 + index),
      classSessionId,
      approvedAt: packet.window.from,
      studentIds: ['child'],
    })),
  ];
  packet.assessments = packet.students.slice(1).map((student, index) =>
    createAssessment({
      id: insightId(10000 + index),
      studentId: student.id,
      episodeId: insightId(20000 + index),
      classSessionId: insightId(1000),
      observedAt: sessionTime(0),
      recordedAt: sessionTime(0),
      method: AssessmentMethod.MODEL,
      purpose: AssessmentPurpose.PRACTICE,
      assistance: AssistanceContext.UNKNOWN,
      individual: null,
      unaidedConfirmed: false,
    }),
  );
  packet.assessments.push(
    ...Array.from({ length: 26 }, (_, index) => {
      const sessionIndex = Math.floor(index / 5);
      const latest = index === 25;
      return createAssessment({
        id: insightId(30000 + index),
        episodeId: insightId(40000 + index),
        episodeOrder: index + 1,
        classSessionId: insightId(1000 + sessionIndex),
        observedAt: sessionTime(sessionIndex),
        recordedAt: sessionTime(sessionIndex),
        status: latest ? PracticeCheckStatus.FAILED : PracticeCheckStatus.COMPLETED,
        results: latest ? [] : createAssessment().results,
        method: AssessmentMethod.MODEL,
        purpose: AssessmentPurpose.PRACTICE,
        assistance: AssistanceContext.HINT,
        individual: true,
        unaidedConfirmed: false,
      });
    }),
  );
  packet.submissions = sessionIds.map((classSessionId, index) => ({
    id: insightId(50000 + index),
    version: 1,
    sourceRevision: '10',
    studentId: 'child',
    classSessionId,
    activityId: insightId(3),
    courseRevisionId: insightId(7),
    sourceKind: 'snapshot',
    snapshotId: insightId(60000 + index),
    checkId: null,
    submittedAt: sessionTime(index),
    sourceIds: [],
  }));
  return packet;
}

describe('synthetic classroom reconciliation above legacy read caps', () => {
  it.each([30, 150])(
    'reconciles a %i-student six-month class without truncating roster or child history',
    (studentCount) => {
      const packet = createSixMonthClass(studentCount);
      const summary = calculateClassSummary(packet);
      expect(InsightClassSummarySchema.safeParse(summary).success).toBe(true);
      expect(summary.students).toHaveLength(studentCount);
      expect(summary).toMatchObject({
        eligible: studentCount,
        checked: studentCount - 1,
        unknown: 1,
      });
      expect(summary.criteria[0]?.counts).toMatchObject({
        met: studentCount - 1,
        notChecked: 1,
        total: studentCount,
      });
      expect(summary.criteria[0]?.counts.sourceIds.length).toBeLessThan(1000);
      const progress = calculateStudentProgress(packet, 'child');
      expect(InsightStudentProgressSchema.safeParse(progress).success).toBe(true);
      expect(progress.assessments).toHaveLength(26);
      expect(progress.sessions).toHaveLength(6);
      expect(progress.sessions[5]?.counts).toMatchObject({ met: 0, notChecked: 1, total: 1 });
      expect(progress.independentTasks).toBe(0);
      expect(progress).toMatchObject({ assigned: 7, handedIn: 7 });
      const sessionSummary = calculateClassSummary(packet, insightId(1005));
      expect(sessionSummary).toMatchObject({ eligible: 1, checked: 0, unknown: 1 });
    },
  );
});
