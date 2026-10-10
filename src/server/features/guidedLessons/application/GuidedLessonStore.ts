import type { MaterialPublication } from '#contracts/ClassroomMaterials.js';
import type { SchoolClass } from '#contracts/Classroom.js';
import type {
  LessonRecord,
  LessonRelease,
  LessonProgress,
  LessonBudget,
  LessonReceipt,
  LessonRequest,
  LessonNote,
} from './LessonState.js';
import type { LessonMediaArtifact } from './LessonPorts.js';

export interface LessonAccess {
  classId: string;
  teacherId: string;
  isTeacher: boolean;
  enrolled: boolean;
  courseRevisionId: string;
}

export interface StoredLessonArtifact extends LessonMediaArtifact {
  classId: string;
  lessonId: string;
  revisionId: string;
}

/** All authorization reads and protected writes use the same transactional store instance. */
export interface GuidedLessonStore {
  runAtomically<T>(work: (store: GuidedLessonStore) => Promise<T>): Promise<T>;
  readAccess(userId: string, classId: string): Promise<LessonAccess | null>;
  listClasses(userId: string): Promise<SchoolClass[]>;
  readPublication(classId: string, courseId: string): Promise<MaterialPublication | null>;
  listLessons(classId: string): Promise<LessonRecord[]>;
  readLesson(id: string): Promise<LessonRecord | null>;
  saveLesson(record: LessonRecord, expectedVersion: number): Promise<void>;
  saveRevision(record: LessonRecord): Promise<void>;
  readRelease(id: string): Promise<LessonRelease | null>;
  saveRelease(release: LessonRelease): Promise<void>;
  withdrawLessonReleases(lessonId: string): Promise<void>;
  listPendingLessons(now: Date): Promise<LessonRecord[]>;
  readBudget(id: string): Promise<LessonBudget | null>;
  saveBudget(budget: LessonBudget, expectedVersion: number): Promise<void>;
  readReceipt(userId: string, commandId: string): Promise<LessonReceipt | null>;
  saveReceipt(
    userId: string,
    classId: string,
    commandId: string,
    receipt: LessonReceipt,
  ): Promise<void>;
  readProgress(studentId: string, releaseId: string): Promise<LessonProgress | null>;
  saveProgress(progress: LessonProgress, expectedVersion: number): Promise<void>;
  listNotes(studentId: string, releaseId: string): Promise<LessonNote[]>;
  saveNote(studentId: string, classId: string, note: LessonNote): Promise<void>;
  deleteNote(studentId: string, releaseId: string, noteId: string): Promise<void>;
  listRequests(classId: string, studentId: string | null): Promise<LessonRequest[]>;
  saveRequest(request: LessonRequest): Promise<void>;
  saveArtifact(artifact: StoredLessonArtifact): Promise<void>;
  readArtifact(artifactId: string): Promise<StoredLessonArtifact | null>;
  readStorageBytes(classId: string): Promise<number>;
  readRevisionStorageBytes(lessonId: string, revisionId: string): Promise<number>;
  deleteExpiredArtifacts(now: Date): Promise<void>;
}
