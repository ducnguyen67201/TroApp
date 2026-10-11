import {
  PetWorldFailure,
  type PetOwnWorld,
  type PetRecognition,
  type PetSharedHome,
  type PetWorldProfile,
} from '#contracts/PetWorld.js';
import type {
  PetRecognitionState,
  PetWalletEntryState,
  PetWorldState,
} from '../domain/PetWorldState.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import type { PetWorldTransaction } from './PetWorldTransaction.js';
import { readOwnedWallet } from './PetWorldOperation.js';

/** Explicit projection constructors prevent private owner fields leaking into visits. */
export function buildPetProfile(world: PetWorldState): PetWorldProfile {
  return {
    activePetId: world.activePetId,
    names: world.names,
    slots: world.slots,
    backdropItemId: world.backdropItemId,
    outfitItemId: world.outfitItemId,
    revision: world.revision,
  };
}

export function buildRecognitionView(recognition: PetRecognitionState): PetRecognition {
  return {
    id: recognition.id,
    classId: recognition.classId,
    teacherId: recognition.teacherId,
    studentId: recognition.studentId,
    batchId: recognition.batchId,
    points: recognition.points,
    category: recognition.category,
    note: recognition.note,
    classSessionId: recognition.classSessionId,
    activityId: recognition.activityId,
    createdAt: recognition.createdAt,
    correction: recognition.correction,
  };
}

export function buildWalletEntryView(entry: PetWalletEntryState): PetOwnWorld['entries'][number] {
  return {
    id: entry.id,
    kind: entry.kind,
    delta: entry.delta.toString(),
    sourceId: entry.sourceId,
    createdAt: entry.createdAt,
  };
}

export async function readOwnWorld(
  transaction: PetWorldTransaction,
  actorId: string,
): Promise<PetOwnWorld> {
  const wallet = await readOwnedWallet(transaction, actorId);
  const world = await transaction.readWorld(actorId);
  return {
    studentId: actorId,
    wallet: { balance: wallet.balance.toString(), revision: wallet.revision },
    profile: world ? buildPetProfile(world) : null,
    inventory: (await transaction.listInventory(actorId)).map((item) => ({
      itemId: item.itemId,
      purchaseId: item.purchaseId,
      acquiredAt: item.acquiredAt,
    })),
    entries: (await transaction.listWalletEntries(actorId, 0, 50)).map(buildWalletEntryView),
    recognitions: (await transaction.listOwnerRecognitions(actorId, 0, 50)).map(
      buildRecognitionView,
    ),
    shares: (await transaction.listHomeShares(actorId)).map((share) => ({
      classId: share.classId,
      enabled: share.enabled,
      revision: share.revision,
    })),
  };
}

export async function readSharedHome(
  transaction: PetWorldTransaction,
  classId: string,
  studentId: string,
): Promise<PetSharedHome> {
  const share = await transaction.readHomeShare(studentId, classId);
  if (!share?.enabled || !(await transaction.isEnrolled(classId, studentId))) {
    throw new PetWorldError(PetWorldFailure.HOME_UNAVAILABLE);
  }
  const world = await transaction.readWorld(studentId);
  if (!world) {
    throw new PetWorldError(PetWorldFailure.HOME_UNAVAILABLE);
  }
  return {
    studentId,
    displayName: world.names[world.activePetId],
    profile: buildPetProfile(world),
  };
}
