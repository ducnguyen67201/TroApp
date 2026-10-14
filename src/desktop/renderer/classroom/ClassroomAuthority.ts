import { AccountRole } from '#contracts/AccountRole.js';
import type { ClassroomHome } from '#contracts/Classroom.js';

/** Scoped authority is supplied by the server; legacy replies use their account role. */
export function canTeachClass(
  home: ClassroomHome,
  entry: ClassroomHome['classes'][number],
  userId: string,
): boolean {
  return (
    entry.canTeach ?? (entry.schoolClass.teacherId === userId && home.role === AccountRole.TEACHER)
  );
}
