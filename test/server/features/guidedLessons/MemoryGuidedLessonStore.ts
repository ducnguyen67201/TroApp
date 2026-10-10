import type { SchoolClass } from '#contracts/Classroom.js';
import type { MaterialPublication } from '#contracts/ClassroomMaterials.js';
import type {
  GuidedLessonStore,
  LessonAccess,
  StoredLessonArtifact,
} from '../../../../src/server/features/guidedLessons/application/GuidedLessonStore.js';
import type {
  LessonRecord,
  LessonRelease,
  LessonProgress,
  LessonBudget,
  LessonReceipt,
  LessonRequest,
  LessonNote,
} from '../../../../src/server/features/guidedLessons/application/LessonState.js';
import {
  LessonError,
  LessonFailure,
} from '../../../../src/server/features/guidedLessons/application/LessonFailure.js';

/** Serial fake transactions model CAS and rollback without making a database a unit-test dependency. */
export class MemoryGuidedLessonStore implements GuidedLessonStore {
  lessons = new Map<string, LessonRecord>();
  releases = new Map<string, LessonRelease>();
  budgets = new Map<string, LessonBudget>();
  progress = new Map<string, LessonProgress>();
  receipts = new Map<string, LessonReceipt>();
  notes = new Map<string, { ownerId: string; note: LessonNote }>();
  requests = new Map<string, LessonRequest>();
  artifacts = new Map<string, StoredLessonArtifact>();
  publications = new Map<string, MaterialPublication>();
  accesses = new Map<string, LessonAccess>();
  revisions = new Map<string, LessonRecord>();
  private tail: Promise<void> = Promise.resolve();

  async runAtomically<T>(work: (store: GuidedLessonStore) => Promise<T>): Promise<T> {
    let unlock: () => void = () => {};
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    const snapshot = structuredClone({
      lessons: this.lessons,
      releases: this.releases,
      budgets: this.budgets,
      progress: this.progress,
      receipts: this.receipts,
      notes: this.notes,
      requests: this.requests,
      artifacts: this.artifacts,
      revisions: this.revisions,
    });
    try {
      return await work(this);
    } catch (error: unknown) {
      Object.assign(this, snapshot);
      throw error;
    } finally {
      unlock();
    }
  }

  readAccess(userId: string, classId: string): Promise<LessonAccess | null> {
    return Promise.resolve(this.accesses.get(`${userId}:${classId}`) ?? null);
  }

  listClasses(userId: string): Promise<SchoolClass[]> {
    return Promise.resolve(
      [...this.accesses.entries()]
        .filter(([key]) => key.startsWith(`${userId}:`))
        .map(([, access]) => ({
          id: access.classId,
          teacherId: access.teacherId,
          name: 'Fixture class',
          courseRevisionId: access.courseRevisionId,
        })),
    );
  }

  readPublication(classId: string, courseId: string): Promise<MaterialPublication | null> {
    const publication = this.publications.get(courseId);
    return Promise.resolve(publication?.classId === classId ? publication : null);
  }

  listLessons(classId: string): Promise<LessonRecord[]> {
    return Promise.resolve(
      [...this.lessons.values()].filter((record) => record.classId === classId),
    );
  }
  readLesson(id: string): Promise<LessonRecord | null> {
    return Promise.resolve(this.lessons.get(id) ?? null);
  }

  saveLesson(record: LessonRecord, expectedVersion: number): Promise<void> {
    if ((this.lessons.get(record.id)?.version ?? 0) !== expectedVersion) {
      return Promise.reject(new LessonError(LessonFailure.STALE));
    }
    this.lessons.set(record.id, structuredClone(record));
    return Promise.resolve();
  }

  saveRevision(record: LessonRecord): Promise<void> {
    this.revisions.set(record.revisionId, structuredClone(record));
    return Promise.resolve();
  }
  readRelease(id: string): Promise<LessonRelease | null> {
    return Promise.resolve(this.releases.get(id) ?? null);
  }
  saveRelease(release: LessonRelease): Promise<void> {
    this.releases.set(release.id, structuredClone(release));
    return Promise.resolve();
  }
  withdrawLessonReleases(lessonId: string): Promise<void> {
    for (const [id, release] of this.releases) {
      if (release.lessonId === lessonId) {
        this.releases.set(id, { ...release, available: false });
      }
    }
    return Promise.resolve();
  }
  listPendingLessons(): Promise<LessonRecord[]> {
    return Promise.resolve(
      [...this.lessons.values()].filter((record) =>
        [
          'admitted',
          'drafting',
          'reviewingContent',
          'repairingContent',
          'recheckingContent',
          'synthesizing',
          'rendering',
          'reviewingVisuals',
          'repairingVisuals',
          'recheckingVisuals',
        ].includes(record.status),
      ),
    );
  }
  readBudget(id: string): Promise<LessonBudget | null> {
    return Promise.resolve(this.budgets.get(id) ?? null);
  }

  saveBudget(budget: LessonBudget, expectedVersion: number): Promise<void> {
    if ((this.budgets.get(budget.id)?.version ?? 0) !== expectedVersion) {
      return Promise.reject(new LessonError(LessonFailure.STALE));
    }
    this.budgets.set(budget.id, structuredClone(budget));
    return Promise.resolve();
  }

  readReceipt(userId: string, commandId: string): Promise<LessonReceipt | null> {
    return Promise.resolve(this.receipts.get(`${userId}:${commandId}`) ?? null);
  }
  saveReceipt(
    userId: string,
    _classId: string,
    commandId: string,
    receipt: LessonReceipt,
  ): Promise<void> {
    this.receipts.set(`${userId}:${commandId}`, structuredClone(receipt));
    return Promise.resolve();
  }
  readProgress(studentId: string, releaseId: string): Promise<LessonProgress | null> {
    return Promise.resolve(this.progress.get(`${studentId}:${releaseId}`) ?? null);
  }

  saveProgress(progress: LessonProgress, expectedVersion: number): Promise<void> {
    const key = `${progress.studentId}:${progress.releaseId}`;
    if ((this.progress.get(key)?.version ?? 0) !== expectedVersion) {
      return Promise.reject(new LessonError(LessonFailure.STALE));
    }
    this.progress.set(key, structuredClone(progress));
    return Promise.resolve();
  }

  listNotes(studentId: string, releaseId: string): Promise<LessonNote[]> {
    return Promise.resolve(
      [...this.notes.values()]
        .filter((item) => item.ownerId === studentId && item.note.anchor.releaseId === releaseId)
        .map((item) => item.note),
    );
  }
  saveNote(studentId: string, _classId: string, note: LessonNote): Promise<void> {
    this.notes.set(note.noteId, {
      ownerId: studentId,
      note: { ...structuredClone(note), expectedVersion: note.expectedVersion + 1 },
    });
    return Promise.resolve();
  }
  deleteNote(studentId: string, releaseId: string, noteId: string): Promise<void> {
    const item = this.notes.get(noteId);
    if (item?.ownerId === studentId && item.note.anchor.releaseId === releaseId) {
      this.notes.delete(noteId);
    }
    return Promise.resolve();
  }
  listRequests(classId: string, studentId: string | null): Promise<LessonRequest[]> {
    return Promise.resolve(
      [...this.requests.values()].filter(
        (item) => item.classId === classId && (studentId === null || item.studentId === studentId),
      ),
    );
  }
  saveRequest(request: LessonRequest): Promise<void> {
    this.requests.set(request.id, structuredClone(request));
    return Promise.resolve();
  }
  saveArtifact(artifact: StoredLessonArtifact): Promise<void> {
    this.artifacts.set(artifact.artifactId, structuredClone(artifact));
    return Promise.resolve();
  }
  readArtifact(id: string): Promise<StoredLessonArtifact | null> {
    return Promise.resolve(this.artifacts.get(id) ?? null);
  }
  readStorageBytes(classId: string): Promise<number> {
    return Promise.resolve(
      [...this.artifacts.values()]
        .filter((item) => item.classId === classId)
        .reduce((sum, item) => sum + item.bytes.byteLength, 0),
    );
  }
  readRevisionStorageBytes(lessonId: string, revisionId: string): Promise<number> {
    return Promise.resolve(
      [...this.artifacts.values()]
        .filter((item) => item.lessonId === lessonId && item.revisionId === revisionId)
        .reduce((sum, item) => sum + item.bytes.byteLength, 0),
    );
  }
  deleteExpiredArtifacts(): Promise<void> {
    return Promise.resolve();
  }
}
