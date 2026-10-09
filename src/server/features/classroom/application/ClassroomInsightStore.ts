import type { ClassroomActivity, ClassMeeting, Participation } from '#contracts/Classroom.js';
import type { PracticeEvidence } from '#contracts/PracticeCheck.js';
import type {
  ClassroomInsightReply,
  InsightRecord,
  InsightRecordKind,
  InsightSourcePacket,
  InsightWindow,
  LearningEvent,
} from '#contracts/ClassroomInsights.js';

export interface InsightAccess {
  classId: string;
  teacherId: string;
  deleted: boolean;
  isTeacher: boolean;
  studentIds: string[];
  historicalStudentIds?: readonly string[];
  courseRevisionId: string;
  activities: ClassroomActivity[];
}

export interface InsightStudentAuthority {
  participation: Participation;
  meeting: ClassMeeting;
  activity: ClassroomActivity;
  studentId: string;
}

export interface InsightReceipt {
  digest: string;
  reply: ClassroomInsightReply;
}

export interface AppendInsightRecord {
  classId: string;
  actorId: string;
  sourceId: string;
  imported: boolean;
  recordedAt: string;
  record: InsightRecord;
  expectedVersion: number;
}

/** Adapters own consistent snapshots and transaction-scoped writes; services authorize facts. */
export interface ClassroomInsightStore {
  runAtomically<T>(work: (store: ClassroomInsightStore) => Promise<T>): Promise<T>;
  readAccess(userId: string, classId: string): Promise<InsightAccess | null>;
  readClassSession(classId: string, classSessionId: string): Promise<ClassMeeting | null>;
  readStudentAuthority(
    userId: string,
    participationId: string,
    activityId: string,
  ): Promise<InsightStudentAuthority | null>;
  readPacket(classId: string, window: InsightWindow, cutoff?: string): Promise<InsightSourcePacket>;
  readRecord(classId: string, kind: InsightRecordKind, id: string): Promise<InsightRecord | null>;
  readEvidence(classId: string, assessmentId: string): Promise<PracticeEvidence[] | null>;
  appendRecord(input: AppendInsightRecord): Promise<InsightRecord>;
  findReceipt(userId: string, requestId: string): Promise<InsightReceipt | null>;
  saveReceipt(
    userId: string,
    classId: string,
    requestId: string,
    digest: string,
    reply: ClassroomInsightReply,
  ): Promise<void>;
  readSourcePage(
    classId: string,
    window: InsightWindow,
    cutoff: string,
    cursor: string | undefined,
    limit: number,
    studentId?: string,
  ): Promise<{ events: LearningEvent[]; nextCursor: string | null }>;
  removeStudentSources(
    classId: string,
    studentId: string,
    actorId: string,
    now: string,
  ): Promise<string>;
}
