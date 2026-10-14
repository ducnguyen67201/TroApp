import { expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import type { ClassroomHome } from '#contracts/Classroom.js';
import { canTeachClass } from '../../../../src/desktop/renderer/classroom/ClassroomAuthority.js';

const entry = {
  schoolClass: { id: 'class', teacherId: 'teacher', name: 'Class', courseRevisionId: 'course' },
  meetings: [],
} satisfies ClassroomHome['classes'][number];
const home = {
  role: AccountRole.TEACHER,
  isAdmin: false,
  courses: [],
  classes: [entry],
} satisfies ClassroomHome;

it('uses per-class authority even when the same account teaches elsewhere', () => {
  expect(canTeachClass(home, { ...entry, canTeach: false }, 'teacher')).toBe(false);
  expect(canTeachClass(home, { ...entry, canTeach: true }, 'teacher')).toBe(true);
  expect(canTeachClass(home, { ...entry, canTeach: true }, 'other')).toBe(true);
});

it('preserves legacy role and class ownership checks when scoped metadata is absent', () => {
  expect(canTeachClass(home, entry, 'teacher')).toBe(true);
  expect(canTeachClass({ ...home, role: AccountRole.STUDENT }, entry, 'teacher')).toBe(false);
  expect(canTeachClass(home, entry, 'other')).toBe(false);
});
