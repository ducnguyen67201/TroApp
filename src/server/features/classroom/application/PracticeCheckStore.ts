import type { PracticeGrounding } from '#contracts/PracticeAssessment.js';
import type { PracticeCheckpoint } from '#contracts/PracticeCheck.js';
import type { ClassroomActivity } from '#contracts/Classroom.js';
import type {
  PracticeEvidence,
  PracticeRecord,
  WorkSubmission,
  PracticeReply,
} from '#contracts/PracticeCheck.js';
export interface PracticeAccess {
  studentId: string;
  teacherId: string;
  classId: string;
  deleted: boolean;
  enrolled: boolean;
  deviceId: string;
  leaseUntil: Date;
  left: boolean;
  status: string;
  phase: string;
  pacing: string;
  currentActivityId: string;
  contextVersion: number;
  progressVersion: number;
  attemptId: string;
  participationId: string;
  courseRevisionId: string;
  activity: ClassroomActivity;
}

export interface StoredPracticeCheck {
  record: PracticeRecord;
  payloadDigest: string;
}

/** Persistence adapters own transactions, private evidence and authenticated relationship reads. */
export interface PracticeCheckStore {
  readGrounding(access: PracticeAccess, rubric: PracticeCheckpoint): Promise<PracticeGrounding>;
  runAtomically<T>(work: (store: PracticeCheckStore) => Promise<T>): Promise<T>;
  readAccess(participationId: string, activityId: string): Promise<PracticeAccess | null>;
  readEvidenceAccess(
    attemptId: string,
  ): Promise<Pick<PracticeAccess, 'studentId' | 'teacherId' | 'deleted' | 'enrolled'> | null>;
  readCheck(id: string): Promise<StoredPracticeCheck | null>;
  findCheck(studentId: string, requestId: string): Promise<StoredPracticeCheck | null>;
  countChecks(studentId: string, since: Date): Promise<number>;
  readStoredEvidenceBytes(studentId: string): Promise<number>;
  createCheck(
    studentId: string,
    courseRevisionId: string,
    payloadDigest: string,
    record: PracticeRecord,
    evidence: PracticeEvidence[],
  ): Promise<void>;
  finishCheck(record: PracticeRecord): Promise<boolean>;
  readEvidence(snapshotId: string): Promise<PracticeEvidence[]>;
  readHistory(attemptId: string): Promise<Extract<PracticeReply, { kind: 'history' }>>;
  findSubmission(
    studentId: string,
    requestId: string,
  ): Promise<{ submission: WorkSubmission; payloadDigest: string } | null>;
  createSubmission(
    studentId: string,
    requestId: string,
    payloadDigest: string,
    check: PracticeRecord,
    now: Date,
  ): Promise<WorkSubmission>;
  readTeacherHistory(
    userId: string,
    sessionId: string,
  ): Promise<Extract<PracticeReply, { kind: 'teacher-history' }> | null>;
}
