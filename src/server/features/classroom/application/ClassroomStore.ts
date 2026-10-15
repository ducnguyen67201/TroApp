import type { MaterialDerivation } from '#contracts/MaterialContext.js';
import type {
  StoredMaterialCollection,
  MaterialPublication,
} from '#contracts/ClassroomMaterials.js';
import type { MaterialFile } from '../../materials/application/MaterialPreparation.js';
import type { AccountRole } from '#contracts/AccountRole.js';
import type {
  AdminClassroomPage,
  AdminClassroomSummary,
  ClassMeeting,
  CourseRevision,
  CourseContent,
  SchoolClass,
  Participation,
  StudentAttempt,
  SubmissionPreparation,
  SubmissionReceipt,
  ClassroomRosterSchema,
} from '#contracts/Classroom.js';
import type { z } from 'zod';
import type { ClassroomPeoplePage, ClassroomPerson } from '#contracts/ClassroomViewAs.js';

/** Persistence port; transaction scopes never expose Prisma to application workflows. */
export interface StoredClassroomInvitation {
  id: string;
  classId: string;
  codeDigest: string;
  email: string | null;
  expiresAt: string;
  revoked: boolean;
}

export interface ClassroomStore {
  readMaterialDerivation(classId: string, key: string): Promise<MaterialDerivation | null>;
  listMaterialDerivations(jobId: string): Promise<MaterialDerivation[]>;
  saveMaterialDerivation(record: MaterialDerivation, expectedClaimId: string | null): Promise<void>;
  readMaterialStorageBytes(classId: string): Promise<number>;
  reserveMaterialPreparation(userId: string, day: string): Promise<void>;
  readMaterialCollection(classId: string): Promise<StoredMaterialCollection | null>;
  saveMaterialCollection(
    collection: StoredMaterialCollection,
    expectedVersion: number,
  ): Promise<void>;
  listPendingMaterials(now: Date): Promise<StoredMaterialCollection[]>;
  saveMaterialFile(file: MaterialFile): Promise<void>;
  readMaterialFile(id: string): Promise<MaterialFile | null>;
  /** Frees an unused original; published revisions retain their source files. */
  deleteUnpublishedMaterialFile(classId: string, materialId: string): Promise<void>;
  saveMaterialPublication(publication: MaterialPublication): Promise<void>;
  readMaterialPublication(courseId: string): Promise<MaterialPublication | null>;
  updateClassCourse(classId: string, courseId: string): Promise<void>;
  readAccountRole(userId: string): Promise<AccountRole>;
  readAdminOrganizationId(userId: string): Promise<string | null>;
  listOrganizationTeachers(organizationId: string): Promise<{ id: string; name: string }[]>;
  canAdministerClass(userId: string, classId: string): Promise<boolean>;
  canTeachClass(userId: string, classId: string): Promise<boolean>;
  listClassTeacherIds(classId: string): Promise<string[]>;
  readClassRole(userId: string, classId: string): Promise<AccountRole | null>;
  readOrganizationRole(userId: string, organizationId: string): Promise<AccountRole | null>;
  listOrganizationMemberships(
    userId: string,
  ): Promise<{ organizationId: string; role: AccountRole }[]>;
  listTeachingOrganizations(userId: string): Promise<{ id: string; name: string }[]>;
  readClassOrganizationId(classId: string): Promise<string | null>;
  readClassOrganization(classId: string): Promise<{ id: string; name: string } | null>;
  readCourseOrganizationId(courseId: string): Promise<string | null>;
  /** Reads the persisted flag; missing users have no admin authority. */
  readIsAdmin(userId: string): Promise<boolean>;
  listClassroomPeople(search: string, offset: number): Promise<ClassroomPeoplePage>;
  readClassroomPerson(userId: string): Promise<ClassroomPerson | null>;
  listClassesForAdmin(search: string, offset: number): Promise<AdminClassroomPage>;
  readClassForAdmin(classId: string): Promise<AdminClassroomSummary | null>;
  readVerifiedEmail(userId: string): Promise<string | null>;
  saveInvitation(invitation: StoredClassroomInvitation): Promise<void>;
  readInvitation(codeDigest: string): Promise<StoredClassroomInvitation | null>;
  revokeInvitations(classId: string): Promise<void>;
  runAtomically<T>(operation: (store: ClassroomStore) => Promise<T>): Promise<T>;
  listCourses(ownerId: string): Promise<CourseRevision[]>;
  saveCourse(
    ownerId: string,
    title: string,
    content: CourseContent,
    organizationId?: string | null,
  ): Promise<CourseRevision>;
  readCourse(id: string): Promise<CourseRevision | null>;
  saveClass(
    teacherId: string,
    name: string,
    courseRevisionId: string,
    organizationId?: string | null,
  ): Promise<SchoolClass>;
  listClasses(userId: string): Promise<SchoolClass[]>;
  readClass(id: string): Promise<SchoolClass | null>;
  /** Removes a class from active use while retaining its submissions and history. */
  deleteClass(classId: string, deletedAt: Date): Promise<void>;
  readStudentByEmail(email: string): Promise<string | null>;
  readOrganizationStudentByExternalId(
    organizationId: string,
    externalId: string,
  ): Promise<string | null>;
  enrollStudent(classId: string, studentId: string, active: boolean): Promise<void>;
  isEnrolled(classId: string, studentId: string): Promise<boolean>;
  listMeetings(classId: string): Promise<ClassMeeting[]>;
  readMeeting(id: string): Promise<ClassMeeting | null>;
  saveMeeting(meeting: ClassMeeting): Promise<void>;
  joinMeeting(
    meetingId: string,
    studentId: string,
    deviceId: string,
    leaseUntil: Date,
  ): Promise<Participation>;
  listJoinedParticipations(studentId: string): Promise<Participation[]>;
  readParticipation(id: string): Promise<Participation | null>;
  saveParticipation(participation: Participation): Promise<void>;
  readOrCreateAttempt(participationId: string, activityId: string): Promise<StudentAttempt>;
  saveAttempt(attempt: StudentAttempt): Promise<void>;
  hasProgressEvent(attemptId: string, eventId: string): Promise<boolean>;
  saveProgressEvent(attemptId: string, eventId: string): Promise<void>;
  savePreparation(preparation: SubmissionPreparation): Promise<void>;
  readPreparation(id: string): Promise<SubmissionPreparation | null>;
  readSubmission(attemptId: string, idempotencyKey: string): Promise<SubmissionReceipt | null>;
  readLatestSubmission(attemptId: string): Promise<SubmissionReceipt | null>;
  saveSubmission(receipt: SubmissionReceipt, idempotencyKey: string): Promise<void>;
  readRoster(meetingId: string, classId: string): Promise<z.infer<typeof ClassroomRosterSchema>>;
  /** Historical members are persisted participants, regardless of current enrollment or leaving. */
  readSessionParticipants(
    meetingId: string,
    classId: string,
  ): Promise<z.infer<typeof ClassroomRosterSchema>>;
}
