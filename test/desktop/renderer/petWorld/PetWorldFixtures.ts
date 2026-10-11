import { vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { AccountRole } from '#contracts/AccountRole.js';
import type { ClassroomHome } from '#contracts/Classroom.js';
import { PetId } from '#contracts/Pet.js';
import type { PetOwnWorld, PetWorldReply } from '#contracts/PetWorld.js';

export const petWorldClassId = '11111111-1111-4111-8111-111111111111';

export const teacherClassroom: ClassroomHome = {
  role: AccountRole.TEACHER,
  courses: [],
  classes: [
    {
      schoolClass: {
        id: petWorldClassId,
        teacherId: 'teacher',
        name: 'Garden class',
        courseRevisionId: '22222222-2222-4222-8222-222222222222',
      },
      meetings: [],
    },
  ],
};

export const emptyGarden = {
  eligibleStudents: 1,
  recognizedStudents: 0,
  recognizedStudentIds: [],
  classroomMoments: 0,
  gardenMilestone: 0,
};

export function createOwnWorld(studentId: string, balance = '20'): PetOwnWorld {
  return {
    studentId,
    wallet: { balance, revision: 1 },
    profile: {
      activePetId: PetId.CAT,
      names: { cat: 'Mochi', fox: 'Maple' },
      slots: { garden: null, home: null, feature: null },
      backdropItemId: null,
      outfitItemId: null,
      revision: 1,
    },
    inventory: [],
    entries: [],
    recognitions: [],
    shares: [],
  };
}

export const emptyRecognition: Extract<PetWorldReply, { kind: 'class-recognition' }> = {
  kind: 'class-recognition',
  classId: petWorldClassId,
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-31T23:59:59.999Z',
  roster: [{ studentId: 'student', displayName: 'An' }],
  recognitions: [],
  coverage: emptyGarden,
  nextCursor: null,
};

export function installPetWorldBridge(
  executePetWorld: NonNullable<DesktopBridge['executePetWorld']>,
  role: AccountRole = AccountRole.STUDENT,
): void {
  const bridge = {
    executePetWorld,
    controlClassroom: vi.fn<NonNullable<DesktopBridge['controlClassroom']>>().mockResolvedValue({
      kind: 'home',
      home: { role, courses: [], classes: [] },
    }),
    readPetWorldPending: vi
      .fn<NonNullable<DesktopBridge['readPetWorldPending']>>()
      .mockResolvedValue([]),
  } satisfies Pick<DesktopBridge, 'executePetWorld' | 'controlClassroom' | 'readPetWorldPending'>;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
}
