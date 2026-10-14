import { AccountRole } from '#contracts/AccountRole.js';
import { PetWorldFailure, type PetWorldReply } from '#contracts/PetWorld.js';
import { calculateGardenProgress } from '../domain/RecognitionCoverage.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import type { PetWorldTransaction } from './PetWorldTransaction.js';
import { requireClassMembership } from './PetWorldOperation.js';
import { buildSharedHome, readSharedHome } from './ReadWorld.js';

export async function requireNeighborhoodAccess(
  transaction: PetWorldTransaction,
  actorId: string,
  classId: string,
): Promise<void> {
  const schoolClass = await transaction.readClassAccess(classId);
  const role = await transaction.readClassRole(actorId, classId);
  if (
    schoolClass &&
    !schoolClass.deleted &&
    (schoolClass.teacherIds?.includes(actorId) ?? schoolClass.teacherId === actorId) &&
    role === AccountRole.TEACHER
  ) {
    return;
  }
  await requireClassMembership(transaction, actorId, classId);
}

export async function readNeighborhood(
  transaction: PetWorldTransaction,
  actorId: string,
  classId: string,
  now: string,
): Promise<PetWorldReply> {
  await requireNeighborhoodAccess(transaction, actorId, classId);
  const worlds = await transaction.listClassWorlds(classId);
  const classroomMoments = await transaction.countClassroomMoments(classId, now);
  return {
    kind: 'neighborhood',
    classId,
    homes: worlds.map(buildSharedHome),
    garden: calculateGardenProgress(classroomMoments),
  };
}

export async function visitHome(
  transaction: PetWorldTransaction,
  actorId: string,
  classId: string,
  studentId: string,
): Promise<PetWorldReply> {
  await requireNeighborhoodAccess(transaction, actorId, classId);
  try {
    return { kind: 'home', home: await readSharedHome(transaction, classId, studentId) };
  } catch (error: unknown) {
    if (error instanceof PetWorldError && error.code === PetWorldFailure.HOME_UNAVAILABLE) {
      throw error;
    }
    throw new PetWorldError(PetWorldFailure.HOME_UNAVAILABLE);
  }
}
