import { AccountRole } from '#contracts/AccountRole.js';
import { PetWorldFailure } from '#contracts/PetWorld.js';
import type { PetClassAccess, PetRosterStudent } from './PetWorldState.js';
import { PetWorldError } from './PetWorldError.js';

export function requireTeacherClassAccess(
  actorId: string,
  role: AccountRole | null,
  schoolClass: PetClassAccess | null,
): void {
  if (
    role !== AccountRole.TEACHER ||
    !schoolClass ||
    schoolClass.deleted ||
    !(schoolClass.teacherIds?.includes(actorId) ?? schoolClass.teacherId === actorId)
  ) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
}

export function requireTeacherGrantRecipients(
  actorId: string,
  studentIds: readonly string[],
  roster: readonly PetRosterStudent[],
): void {
  const students = new Map(roster.map((student) => [student.studentId, student]));
  if (
    new Set(studentIds).size !== studentIds.length ||
    studentIds.some((id) => id === actorId || students.get(id)?.role !== AccountRole.STUDENT)
  ) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
}
