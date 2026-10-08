import type { MaterialDerivation } from '#contracts/MaterialContext.js';
import type {
  StoredMaterialCollection,
  MaterialPublication,
} from '#contracts/ClassroomMaterials.js';
import type { MaterialFile } from '../../../../src/server/features/materials/application/MaterialPreparation.js';
import { ClassroomError } from '../../../../src/server/features/classroom/domain/ClassroomRules.js';
import { ClassroomFailure } from '#contracts/Classroom.js';
import { AccountRole } from '#contracts/AccountRole.js';
import { randomUUID } from 'node:crypto';
import type {
  ClassroomStore,
  StoredClassroomInvitation,
} from '../../../../src/server/features/classroom/application/ClassroomStore.js';
import {
  ClassroomPacing,
  ClassroomPhase,
  ClassroomStatus,
  SubmissionRequirement,
  type CourseContent,
  type CourseRevision,
  type SchoolClass,
  type ClassMeeting,
  type Participation,
  type StudentAttempt,
  type SubmissionPreparation,
  type SubmissionReceipt,
  type TeachingContext,
} from '#contracts/Classroom.js';

export function createCourseContent(): CourseContent {
  return {
    modules: [
      {
        title: 'Scratch',
        lessons: [
          {
            title: 'Move and speak',
            activities: [0, 1].map((index) => ({
              id: randomUUID(),
              title: `Section ${String(index + 1)}`,
              objective: 'Run the connected script with the green flag',
              instructions: 'Connect the event, movement and speech blocks.',
              prerequisites: ['A green-flag event must be connected for green-flag execution.'],
              criteria: [
                { id: randomUUID(), description: 'The green flag runs the connected script.' },
              ],
              materials: [],
              submission: SubmissionRequirement.SCRATCH_LINK,
            })),
          },
        ],
      },
    ],
  };
}

/** Typed test persistence; concurrency and isolation are checked against PostgreSQL. */
export class MemoryClassroomStore implements ClassroomStore {
  readonly deletedClasses = new Set<string>();
  readonly materialDerivations = new Map<string, MaterialDerivation>();
  readMaterialDerivation(classId: string, key: string) {
    return Promise.resolve(this.materialDerivations.get(`${classId}:${key}`) ?? null);
  }
  listMaterialDerivations(jobId: string) {
    return Promise.resolve(
      [...this.materialDerivations.values()].filter((record) => record.jobId === jobId),
    );
  }
  saveMaterialDerivation(record: MaterialDerivation, expectedClaimId: string | null) {
    const key = `${record.classId}:${record.key}`;
    if ((this.materialDerivations.get(key)?.claimId ?? null) !== expectedClaimId) {
      throw new ClassroomError(ClassroomFailure.STALE);
    }
    this.materialDerivations.set(key, structuredClone(record));
    return Promise.resolve();
  }
  readonly materialCollections = new Map<string, StoredMaterialCollection>();
  readonly materialFiles = new Map<string, MaterialFile>();
  readonly materialPublications = new Map<string, MaterialPublication>();
  readMaterialStorageBytes(classId: string) {
    return Promise.resolve(
      [...this.materialFiles.values()]
        .filter((file) => file.classId === classId)
        .reduce((sum, file) => sum + file.bytes.length, 0),
    );
  }
  reserveMaterialPreparation() {
    return Promise.resolve();
  }
  readMaterialCollection(classId: string) {
    return Promise.resolve(this.materialCollections.get(classId) ?? null);
  }
  saveMaterialCollection(collection: StoredMaterialCollection, version: number) {
    if ((this.materialCollections.get(collection.classId)?.version ?? 0) !== version) {
      throw new ClassroomError(ClassroomFailure.STALE);
    }
    this.materialCollections.set(collection.classId, structuredClone(collection));
    return Promise.resolve();
  }
  listPendingMaterials(now: Date) {
    return Promise.resolve(
      [...this.materialCollections.values()].filter(
        (item) =>
          !this.deletedClasses.has(item.classId) &&
          (item.state === 'queued' ||
            (item.state === 'preparing' && Date.parse(item.leaseUntil ?? '') < now.getTime())),
      ),
    );
  }
  saveMaterialFile(file: MaterialFile) {
    this.materialFiles.set(file.id, file);
    return Promise.resolve();
  }
  readMaterialFile(id: string) {
    return Promise.resolve(this.materialFiles.get(id) ?? null);
  }
  deleteUnpublishedMaterialFile(classId: string, materialId: string) {
    const published = [...this.materialPublications.values()].some((publication) =>
      publication.sources.some((source) => source.id === materialId),
    );
    if (!published && this.materialFiles.get(materialId)?.classId === classId) {
      this.materialFiles.delete(materialId);
    }
    return Promise.resolve();
  }
  saveMaterialPublication(publication: MaterialPublication) {
    this.materialPublications.set(publication.courseId, structuredClone(publication));
    return Promise.resolve();
  }
  readMaterialPublication(courseId: string) {
    return Promise.resolve(this.materialPublications.get(courseId) ?? null);
  }
  updateClassCourse(classId: string, courseRevisionId: string) {
    const item = this.classes.get(classId);
    if (item) {
      this.classes.set(classId, { ...item, courseRevisionId });
    }
    return Promise.resolve();
  }

  readonly roles = new Map<string, AccountRole>([['teacher', AccountRole.TEACHER]]);
  readonly emails = new Map<string, string | null>();
  readonly invitations = new Map<string, StoredClassroomInvitation>();

  readAccountRole(userId: string) {
    return Promise.resolve(this.roles.get(userId) ?? AccountRole.STUDENT);
  }
  readVerifiedEmail(userId: string) {
    return Promise.resolve(
      this.emails.has(userId) ? (this.emails.get(userId) ?? null) : `${userId}@example.test`,
    );
  }
  saveInvitation(invitation: StoredClassroomInvitation) {
    this.invitations.set(invitation.codeDigest, invitation);
    return Promise.resolve();
  }
  readInvitation(digest: string) {
    return Promise.resolve(this.invitations.get(digest) ?? null);
  }
  revokeInvitations(classId: string) {
    for (const [digest, invitation] of this.invitations) {
      if (invitation.classId === classId) {
        this.invitations.set(digest, { ...invitation, revoked: true });
      }
    }
    return Promise.resolve();
  }

  readonly courses = new Map<string, CourseRevision>();
  readonly classes = new Map<string, SchoolClass>();
  readonly meetings = new Map<string, ClassMeeting>();
  readonly participations = new Map<string, Participation>();
  readonly attempts = new Map<string, StudentAttempt>();
  readonly preparations = new Map<string, SubmissionPreparation>();
  readonly submissions = new Map<string, SubmissionReceipt>();
  readonly enrollments = new Set<string>();
  readonly events = new Set<string>();

  runAtomically<T>(operation: (store: ClassroomStore) => Promise<T>): Promise<T> {
    return operation(this);
  }
  listCourses(ownerId: string) {
    return Promise.resolve(
      [...this.courses.values()].filter((course) => course.ownerId === ownerId),
    );
  }
  saveCourse(ownerId: string, title: string, content: CourseContent) {
    const course = { id: randomUUID(), ownerId, title, content };
    this.courses.set(course.id, course);
    return Promise.resolve(course);
  }
  readCourse(id: string) {
    return Promise.resolve(this.courses.get(id) ?? null);
  }
  saveClass(teacherId: string, name: string, courseRevisionId: string) {
    const schoolClass = { id: randomUUID(), teacherId, name, courseRevisionId };
    this.classes.set(schoolClass.id, schoolClass);
    return Promise.resolve(schoolClass);
  }
  listClasses(userId: string) {
    return Promise.resolve(
      [...this.classes.values()].filter(
        (schoolClass) =>
          !this.deletedClasses.has(schoolClass.id) &&
          (schoolClass.teacherId === userId || this.enrollments.has(`${schoolClass.id}:${userId}`)),
      ),
    );
  }
  readClass(id: string) {
    return Promise.resolve(this.deletedClasses.has(id) ? null : (this.classes.get(id) ?? null));
  }
  deleteClass(classId: string) {
    this.deletedClasses.add(classId);
    return Promise.resolve();
  }
  readStudentByEmail(email: string) {
    return Promise.resolve(email.split('@')[0] ?? null);
  }
  enrollStudent(classId: string, studentId: string, active: boolean) {
    if (active) {
      this.enrollments.add(`${classId}:${studentId}`);
    } else {
      this.enrollments.delete(`${classId}:${studentId}`);
    }
    return Promise.resolve();
  }
  isEnrolled(classId: string, studentId: string) {
    return Promise.resolve(this.enrollments.has(`${classId}:${studentId}`));
  }
  listMeetings(classId: string) {
    return Promise.resolve(
      [...this.meetings.values()].filter((meeting) => meeting.classId === classId),
    );
  }
  readMeeting(id: string) {
    return Promise.resolve(this.meetings.get(id) ?? null);
  }
  saveMeeting(meeting: ClassMeeting) {
    this.meetings.set(meeting.id, meeting);
    return Promise.resolve();
  }
  joinMeeting(classSessionId: string, studentId: string, deviceId: string, leaseUntil: Date) {
    const existing = [...this.participations.values()].find(
      (participation) =>
        participation.classSessionId === classSessionId && participation.studentId === studentId,
    );
    const participation = {
      id: existing?.id ?? randomUUID(),
      classSessionId,
      studentId,
      deviceId,
      leaseUntil: leaseUntil.toISOString(),
      left: false,
    };
    this.participations.set(participation.id, participation);
    return Promise.resolve(participation);
  }
  listJoinedParticipations(studentId: string) {
    return Promise.resolve(
      [...this.participations.values()]
        .filter(
          (participation) =>
            participation.studentId === studentId &&
            !participation.left &&
            this.meetings.get(participation.classSessionId)?.status === ClassroomStatus.LIVE,
        )
        .sort((first, second) => second.leaseUntil.localeCompare(first.leaseUntil)),
    );
  }
  readParticipation(id: string) {
    return Promise.resolve(this.participations.get(id) ?? null);
  }
  saveParticipation(participation: Participation) {
    this.participations.set(participation.id, participation);
    return Promise.resolve();
  }
  readOrCreateAttempt(participationId: string, activityId: string) {
    const key = `${participationId}:${activityId}`;
    const attempt = this.attempts.get(key) ?? {
      id: randomUUID(),
      participationId,
      activityId,
      progressVersion: 0,
      workspaceUrl: null,
      evidence: [],
      declaredComplete: false,
      helpSummary: '',
    };
    this.attempts.set(key, attempt);
    return Promise.resolve(attempt);
  }
  saveAttempt(attempt: StudentAttempt) {
    this.attempts.set(`${attempt.participationId}:${attempt.activityId}`, attempt);
    return Promise.resolve();
  }
  hasProgressEvent(attemptId: string, eventId: string) {
    return Promise.resolve(this.events.has(`${attemptId}:${eventId}`));
  }
  saveProgressEvent(attemptId: string, eventId: string) {
    this.events.add(`${attemptId}:${eventId}`);
    return Promise.resolve();
  }
  savePreparation(preparation: SubmissionPreparation) {
    this.preparations.set(preparation.id, preparation);
    return Promise.resolve();
  }
  readPreparation(id: string) {
    return Promise.resolve(this.preparations.get(id) ?? null);
  }
  readSubmission(attemptId: string, idempotencyKey: string) {
    return Promise.resolve(this.submissions.get(`${attemptId}:${idempotencyKey}`) ?? null);
  }
  readLatestSubmission(attemptId: string) {
    const receipts = [...this.submissions.values()]
      .filter((receipt) => receipt.attemptId === attemptId)
      .sort((first, second) => second.submittedAt.localeCompare(first.submittedAt));
    return Promise.resolve(receipts[0] ?? null);
  }
  saveSubmission(receipt: SubmissionReceipt, idempotencyKey: string) {
    this.submissions.set(`${receipt.attemptId}:${idempotencyKey}`, receipt);
    return Promise.resolve();
  }
  readRoster() {
    return Promise.resolve([]);
  }
}

export function createTeachingContext(): TeachingContext {
  const course = createCourseContent();
  const activity = course.modules[0]?.lessons[0]?.activities[0];
  if (!activity) {
    throw new Error('Fixture activity is missing.');
  }
  const participationId = randomUUID();
  const meetingId = randomUUID();
  return {
    className: 'Scratch class',
    latestSubmission: null,
    courseRevisionId: randomUUID(),
    meeting: {
      id: meetingId,
      classId: randomUUID(),
      status: ClassroomStatus.LIVE,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.TEACHER,
      currentActivityId: activity.id,
      contextVersion: 1,
    },
    participation: {
      id: participationId,
      classSessionId: meetingId,
      studentId: 'student',
      deviceId: randomUUID(),
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      left: false,
    },
    activity,
    attempt: {
      id: randomUUID(),
      participationId,
      activityId: activity.id,
      progressVersion: 0,
      workspaceUrl: null,
      evidence: [],
      declaredComplete: false,
      helpSummary: '',
    },
    availableActivities: [{ id: activity.id, title: activity.title }],
  };
}
