import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationFailure,
  type OrganizationCommand,
} from '#contracts/Organizations.js';
import { OrganizationError } from '../domain/OrganizationError.js';
import type { OrganizationStore, StoredOrganizationClass } from './OrganizationStore.js';

type AssignClassTeacher = Extract<
  OrganizationCommand,
  { kind: typeof OrganizationAction.ASSIGN_CLASS_TEACHER }
>;
type SetClassTeachers = Extract<
  OrganizationCommand,
  { kind: typeof OrganizationAction.SET_CLASS_TEACHERS }
>;
type LinkClass = Extract<OrganizationCommand, { kind: typeof OrganizationAction.LINK_CLASS }>;

async function readExistingClass(
  store: OrganizationStore,
  classId: string,
): Promise<StoredOrganizationClass> {
  const schoolClass = await store.readClass(classId);
  if (!schoolClass) {
    throw new OrganizationError(OrganizationFailure.FORBIDDEN);
  }
  return schoolClass;
}

function requireEndedSessions(schoolClass: StoredOrganizationClass): void {
  if (schoolClass.hasLiveSession) {
    throw new OrganizationError(OrganizationFailure.CONFLICT);
  }
}

async function requireTeacherMember(
  store: OrganizationStore,
  organizationId: string,
  teacherId: string,
): Promise<void> {
  const teacher = await store.readMembership(organizationId, teacherId);
  if (!teacher || teacher.removedAt !== null || teacher.role !== AccountRole.TEACHER) {
    throw new OrganizationError(OrganizationFailure.FORBIDDEN);
  }
}

/** The caller verifies organization ownership and name setup in the same transaction. */
export async function assignOrganizationClassTeacher(
  store: OrganizationStore,
  command: AssignClassTeacher,
): Promise<void> {
  const schoolClass = await readExistingClass(store, command.classId);
  if (schoolClass.organizationId !== command.organizationId) {
    throw new OrganizationError(OrganizationFailure.FORBIDDEN);
  }
  requireEndedSessions(schoolClass);
  await requireTeacherMember(store, command.organizationId, command.teacherId);
  const teacherIds = schoolClass.teacherIds ?? [schoolClass.teacherId];
  if (teacherIds.length !== 1 || teacherIds[0] !== command.expectedTeacherId) {
    throw new OrganizationError(OrganizationFailure.CONFLICT);
  }
  await store.saveClassTeachers(schoolClass.id, [command.teacherId]);
}

/** Updates the complete assignment set under the caller's owner-authorized transaction. */
export async function setOrganizationClassTeachers(
  store: OrganizationStore,
  command: SetClassTeachers,
): Promise<void> {
  const schoolClass = await readExistingClass(store, command.classId);
  if (schoolClass.organizationId !== command.organizationId) {
    throw new OrganizationError(OrganizationFailure.FORBIDDEN);
  }
  requireEndedSessions(schoolClass);
  const current = schoolClass.teacherIds ?? [schoolClass.teacherId];
  if (
    current.length !== command.expectedTeacherIds.length ||
    current.some((id) => !command.expectedTeacherIds.includes(id))
  ) {
    throw new OrganizationError(OrganizationFailure.CONFLICT);
  }
  for (const teacherId of command.teacherIds) {
    await requireTeacherMember(store, command.organizationId, teacherId);
  }
  await store.saveClassTeachers(schoolClass.id, command.teacherIds);
}

/**
 * The caller verifies ownership and name setup in the same transaction.
 * Links only the owner's personal class; enrollment and history are retained.
 */
export async function linkPersonalClassToOrganization(
  store: OrganizationStore,
  ownerId: string,
  command: LinkClass,
): Promise<void> {
  const schoolClass = await readExistingClass(store, command.classId);
  if (schoolClass.organizationId !== null || schoolClass.teacherId !== ownerId) {
    throw new OrganizationError(OrganizationFailure.FORBIDDEN);
  }
  requireEndedSessions(schoolClass);
  await requireTeacherMember(store, command.organizationId, schoolClass.teacherId);
  if (!schoolClass.canLinkCourse) {
    throw new OrganizationError(OrganizationFailure.CONFLICT);
  }
  for (const userId of schoolClass.enrolledUserIds) {
    const member = await store.readMembership(command.organizationId, userId);
    if (!member || member.removedAt !== null) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
  }
  await store.linkClass(schoolClass.id, schoolClass.courseRevisionId, command.organizationId);
}
