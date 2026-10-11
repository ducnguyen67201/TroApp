import { AccountRole } from '#contracts/AccountRole.js';
import { PetWorldFailure, type PetWorldReply } from '#contracts/PetWorld.js';
import { calculateRecognitionCoverage } from '../domain/RecognitionCoverage.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import type { PetWorldTransaction } from './PetWorldTransaction.js';
import { requireClassMembership } from './PetWorldOperation.js';
import { readSharedHome } from './ReadWorld.js';

export async function requireNeighborhoodAccess(
  transaction: PetWorldTransaction,
  actorId: string,
  classId: string,
): Promise<void> {
  const schoolClass = await transaction.readClassAccess(classId);
  const role = await transaction.readAccountRole(actorId);
  if (
    schoolClass &&
    !schoolClass.deleted &&
    schoolClass.teacherId === actorId &&
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
  const roster = await transaction.listClassRoster(classId);
  const homes: Extract<PetWorldReply, { kind: 'neighborhood' }>['homes'] = [];
  for (const student of roster) {
    const share = await transaction.readHomeShare(student.studentId, classId);
    if (share?.enabled) {
      const world = await transaction.readWorld(student.studentId);
      if (world) {
        homes.push(await readSharedHome(transaction, classId, student.studentId));
      }
    }
  }
  const records = await transaction.listClassRecognitions(classId, '1970-01-01T00:00:00.000Z', now);
  const garden = calculateRecognitionCoverage(roster, records);
  return {
    kind: 'neighborhood',
    classId,
    homes,
    garden: { classroomMoments: garden.classroomMoments, gardenMilestone: garden.gardenMilestone },
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
