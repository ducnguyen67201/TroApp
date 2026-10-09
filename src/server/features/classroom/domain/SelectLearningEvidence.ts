import {
  InsightFailure,
  type InsightAssessment,
  type InsightSourcePacket,
  type InsightWindow,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus } from '#contracts/PracticeCheck.js';
import { ClassroomInsightError } from './ClassroomInsightError.js';

export interface SelectedLearningEvidence {
  assessment: InsightAssessment;
  records: InsightAssessment[];
  conflictingCriterionIds: string[];
  hasUnknownOrder: boolean;
}

/** Decimal revisions are compared without a floating-point precision limit. */
export function isWithinSourceRevision(revision: string, cutoff: string): boolean {
  return BigInt(revision) <= BigInt(cutoff);
}

export function isWithinInsightWindow(at: string, window: InsightWindow): boolean {
  return Date.parse(at) >= Date.parse(window.from) && Date.parse(at) <= Date.parse(window.to);
}

/** Select the latest immutable version visible at the supplied replay cutoff. */
export function selectRecordVersions<
  T extends { id: string; version: number; sourceRevision: string },
>(records: readonly T[], cutoff: string): T[] {
  const selected = new Map<string, T>();
  for (const record of records) {
    if (!isWithinSourceRevision(record.sourceRevision, cutoff)) {
      continue;
    }
    const prior = selected.get(record.id);
    if (
      !prior ||
      record.version > prior.version ||
      (record.version === prior.version &&
        BigInt(record.sourceRevision) > BigInt(prior.sourceRevision))
    ) {
      selected.set(record.id, record);
    }
  }
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function hasSameEpisode(left: InsightAssessment, right: InsightAssessment): boolean {
  return (
    left.studentId === right.studentId &&
    left.episodeId === right.episodeId &&
    left.activityId === right.activityId &&
    left.classSessionId === right.classSessionId &&
    left.courseRevisionId === right.courseRevisionId &&
    left.rubricRevisionId === right.rubricRevisionId
  );
}

/** Keep episodes separate; completion arrival time cannot establish learning order. */
export function selectLearningEvidence(
  packet: InsightSourcePacket,
  studentId: string,
): SelectedLearningEvidence[] {
  if (packet.removedStudentIds.includes(studentId)) {
    return [];
  }
  const visible = selectRecordVersions(packet.assessments, packet.sourceRevision).filter(
    (record) => record.studentId === studentId,
  );
  const byId = new Map(visible.map((record) => [record.id, record]));
  const superseded = new Set<string>();
  for (const record of visible) {
    const visited = new Set([record.id]);
    let correction = record;
    while (correction.supersedesId !== null) {
      const prior = byId.get(correction.supersedesId);
      if (!prior || !hasSameEpisode(record, prior)) {
        break;
      }
      if (visited.has(prior.id)) {
        throw new ClassroomInsightError(InsightFailure.INVALID);
      }
      visited.add(prior.id);
      superseded.add(prior.id);
      correction = prior;
    }
  }
  const episodes = new Map<string, InsightAssessment[]>();
  for (const record of visible) {
    if (superseded.has(record.id) || !isWithinInsightWindow(record.observedAt, packet.window)) {
      continue;
    }
    const key = JSON.stringify([
      record.episodeId,
      record.activityId,
      record.classSessionId,
      record.courseRevisionId,
      record.rubricRevisionId,
    ]);
    const records = episodes.get(key) ?? [];
    records.push(record);
    episodes.set(key, records);
  }
  const selected: SelectedLearningEvidence[] = [];
  for (const records of episodes.values()) {
    const completed = records.filter((record) => record.status === PracticeCheckStatus.COMPLETED);
    const candidates = completed.length > 0 ? completed : records;
    candidates.sort((left, right) => left.id.localeCompare(right.id));
    const assessment = candidates[0];
    if (!assessment) {
      continue;
    }
    const contexts = new Set(
      candidates.map((record) =>
        JSON.stringify([
          record.snapshotId,
          record.purpose,
          record.assistance,
          record.individual,
          record.unaidedConfirmed,
          record.method,
          record.observedAt,
        ]),
      ),
    );
    const conflictingCriterionIds = assessment.criteria
      .filter((criterion) => {
        if (contexts.size > 1) {
          return true;
        }
        const findings = new Set(
          candidates.map(
            (record) =>
              record.results.find((result) => result.criterionId === criterion.id)?.finding ??
              'missing',
          ),
        );
        return findings.size > 1;
      })
      .map((criterion) => criterion.id);
    selected.push({
      assessment,
      records: candidates,
      conflictingCriterionIds,
      hasUnknownOrder:
        records.some((record) => record.episodeOrder === null) ||
        new Set(records.map((record) => record.episodeOrder)).size > 1,
    });
  }
  return selected.sort(
    (left, right) =>
      Date.parse(left.assessment.observedAt) - Date.parse(right.assessment.observedAt) ||
      left.assessment.episodeId.localeCompare(right.assessment.episodeId),
  );
}
