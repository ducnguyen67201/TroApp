import { describe, expect, it } from 'vitest';
import {
  AssistanceContext,
  ParentReportSchema,
  ReportStatus,
} from '#contracts/ClassroomInsights.js';
import { buildParentReport } from '../../../../../src/server/features/classroom/domain/BuildParentReport.js';
import { calculateStudentProgress } from '../../../../../src/server/features/classroom/domain/CalculateStudentProgress.js';
import { createAssessment, createInsightPacket, insightId } from './ClassroomInsightFixtures.js';

describe('buildParentReport', () => {
  const author = { id: insightId(500), createdBy: 'teacher', createdAt: '2026-10-31T23:59:59Z' };

  it('freezes deterministic sourced factual blocks independently of commentary', () => {
    const progress = calculateStudentProgress(createInsightPacket(), 'child');
    const report = buildParentReport(progress, author);
    expect(ParentReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      version: 1,
      sourceRevision: '100',
      status: ReportStatus.DRAFT,
      commentary: '',
      approvedBy: null,
      approvedAt: null,
    });
    expect(report.facts.every((fact) => fact.sourceIds.length > 0)).toBe(true);
    expect(buildParentReport(progress, author)).toEqual(report);
    progress.identity.planIds.push(insightId(501));
    progress.sessions.splice(0);
    expect(report.identity.planIds).toHaveLength(1);
    expect(report.sessions).toHaveLength(1);
  });

  it('names recorded tasks and targets without inferring outcomes from conflicting raw feedback', () => {
    const original = createAssessment({
      results: createAssessment().results.map((result) => ({
        ...result,
        feedback: 'PRIVATE feedback: improved because of help',
      })),
    });
    const sibling = createAssessment({
      id: insightId(101),
      assistance: AssistanceContext.HINT,
      unaidedConfirmed: false,
    });
    const report = buildParentReport(
      calculateStudentProgress(
        createInsightPacket({
          assessments: [
            original,
            sibling,
            createAssessment({
              id: insightId(102),
              studentId: 'other',
              title: 'Other child private topic',
            }),
          ],
        }),
        'child',
      ),
      author,
    );
    const task = report.facts.find((fact) => fact.id === 'recorded-task-1');
    expect(task?.text).toContain('Recorded task: Stop the robot');
    expect(task?.text).toContain('Learning targets: Explain the stop condition');
    expect(task?.text).toContain('assistance: varies across checks');
    expect(task?.sourceIds).toContain(original.id);
    expect(task?.sourceIds).toContain(sibling.id);
    expect(JSON.stringify(report.facts)).not.toContain('PRIVATE feedback');
    expect(JSON.stringify(report.facts)).not.toContain('Other child private topic');
    expect(JSON.stringify(report.facts)).not.toContain('improved because');
  });

  it('bounds task blocks and names the teacher-selected next activity with exact sources', () => {
    const nextTask = {
      id: insightId(600),
      version: 1,
      sourceRevision: '10',
      studentId: 'child',
      activityId: insightId(3),
      courseRevisionId: insightId(7),
      selectedBy: 'teacher',
      selectedAt: '2026-10-20T10:00:00Z',
      title: 'Practice sensor stops',
      sourceIds: [insightId(601)],
    };
    const packet = createInsightPacket({
      assessments: Array.from({ length: 4 }, (_, index) =>
        createAssessment({
          id: insightId(100 + index),
          episodeId: insightId(300 + index),
          episodeOrder: index,
          title: `Approved task ${String(index + 1)}`,
          assistance: AssistanceContext.UNKNOWN,
          unaidedConfirmed: false,
        }),
      ),
      nextTasks: [nextTask],
    });
    const report = buildParentReport(calculateStudentProgress(packet, 'child'), author);
    expect(report.facts.filter((fact) => fact.id.startsWith('recorded-task-'))).toHaveLength(3);
    expect(report.facts.find((fact) => fact.id === 'recorded-task-1')?.text).toContain(
      'assistance: unknown',
    );
    expect(report.facts.find((fact) => fact.id === 'next-task')).toEqual({
      id: 'next-task',
      text: 'The teacher selected the next activity: Practice sensor stops.',
      sourceIds: [nextTask.id, insightId(601)],
    });
    expect(report.facts.every((fact) => fact.text.length <= 2000)).toBe(true);
  });

  it('keeps long target descriptions complete within the factual block limit', () => {
    const descriptions = ['A'.repeat(500), 'B'.repeat(500), 'C'.repeat(500), 'D'.repeat(500)];
    const progress = calculateStudentProgress(createInsightPacket(), 'child');
    progress.assessments = [
      createAssessment({
        title: 'T'.repeat(200),
        criteria: descriptions.map((description, index) => ({
          id: insightId(700 + index),
          description,
          required: true,
        })),
      }),
    ];
    const report = buildParentReport(progress, author);
    const task = report.facts.find((fact) => fact.id === 'recorded-task-1');
    expect(task?.text.length).toBeLessThanOrEqual(2000);
    expect(task?.text).toContain('A'.repeat(500));
    expect(task?.text).toContain('B'.repeat(500));
    expect(task?.text).toContain('C'.repeat(500));
    expect(task?.text).not.toContain('D'.repeat(100));
    expect(task?.text).toContain('Additional learning targets are recorded');
    expect(task?.sourceIds).toContain(insightId(100));
    expect(ParentReportSchema.safeParse(report).success).toBe(true);
    progress.assessments = [
      createAssessment({
        sourceIds: Array.from({ length: 600 }, (_, index) => `source-${String(index)}`),
      }),
      createAssessment({
        id: insightId(101),
        sourceIds: Array.from({ length: 600 }, (_, index) => `source-${String(index + 600)}`),
      }),
    ];
    expect(() => buildParentReport(progress, author)).toThrow('limit');
  });

  it('reports recorded support context without copying notes or claiming causal improvement', () => {
    const packet = createInsightPacket({
      support: [
        {
          id: insightId(610),
          version: 1,
          sourceRevision: '10',
          studentId: 'child',
          classSessionId: insightId(2),
          activityId: insightId(3),
          criterionId: null,
          requestedAt: '2026-10-03T10:00:00Z',
          category: 'Stop condition',
          interventions: [
            {
              id: insightId(611),
              authorId: 'teacher',
              at: '2026-10-03T10:01:00Z',
              type: AssistanceContext.HINT,
              note: 'PRIVATE teacher note',
            },
          ],
          closedAt: '2026-10-03T10:02:00Z',
          reportedOutcome: 'PRIVATE causal claim',
          sourceIds: [insightId(612)],
        },
      ],
    });
    const report = buildParentReport(calculateStudentProgress(packet, 'child'), author);
    const support = report.facts.find((fact) => fact.id === 'recorded-support');
    expect(support?.text).toContain('1 help request was recorded');
    expect(support?.text).toContain('intervention types: hint');
    expect(support?.text).toContain('Recorded outcome notes: 1 request');
    expect(support?.sourceIds).toEqual([insightId(610), insightId(611), insightId(612)]);
    expect(JSON.stringify(report.facts)).not.toContain('PRIVATE');
  });

  it('reports unknown assignment coverage and keeps removed histories empty', () => {
    const unknown = buildParentReport(
      calculateStudentProgress(createInsightPacket({ plans: [] }), 'child'),
      author,
    );
    expect(unknown.facts.find((fact) => fact.id === 'hand-ins')?.text).toContain('unknown');
    const removed = buildParentReport(
      calculateStudentProgress(createInsightPacket({ removedStudentIds: ['child'] }), 'child'),
      author,
    );
    expect(removed.facts).toHaveLength(1);
    expect(removed.sessions).toEqual([]);
    expect(removed.sourceIds).not.toContain(insightId(100));
  });
});
