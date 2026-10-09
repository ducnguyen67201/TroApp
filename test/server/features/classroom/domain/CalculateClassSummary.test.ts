import { describe, expect, it } from 'vitest';
import { InsightClassSummarySchema } from '#contracts/ClassroomInsights.js';
import { calculateClassSummary } from '../../../../../src/server/features/classroom/domain/CalculateClassSummary.js';
import { createInsightPacket, insightId } from './ClassroomInsightFixtures.js';

describe('calculateClassSummary', () => {
  it('uses approved eligibility and preserves unchecked children', () => {
    const summary = calculateClassSummary(createInsightPacket());
    expect(InsightClassSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({ eligible: 2, checked: 1, unknown: 1 });
    expect(summary.criteria[0]?.counts).toMatchObject({ met: 1, notChecked: 1, total: 2 });
  });

  it('uses exact session plans and never substitutes the current roster', () => {
    const packet = createInsightPacket();
    expect(calculateClassSummary(packet, insightId(2)).eligible).toBeNull();
    const plan = packet.plans[0];
    if (!plan) {
      throw new Error('Fixture plan missing');
    }
    plan.classSessionId = insightId(2);
    packet.students.push({ id: 'new-child', name: 'New', enrolled: true });
    expect(calculateClassSummary(packet, insightId(2))).toMatchObject({
      eligible: 2,
      checked: 1,
      unknown: 1,
    });
  });

  it('keeps removed eligibility visible as removed without exposing learner evidence', () => {
    const summary = calculateClassSummary(createInsightPacket({ removedStudentIds: ['child'] }));
    expect(summary).toMatchObject({ eligible: 2, checked: 0, unknown: 2 });
    expect(summary.criteria[0]?.counts).toMatchObject({
      removed: 1,
      notChecked: 1,
      met: 0,
      total: 2,
    });
  });
});
