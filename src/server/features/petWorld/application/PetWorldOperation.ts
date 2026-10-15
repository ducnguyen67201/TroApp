import { AccountRole } from '#contracts/AccountRole.js';
import {
  PetWorldFailure,
  type PetWorldMutationCommand,
  type PetWorldMutationReply,
} from '#contracts/PetWorld.js';
import { requireTeacherClassAccess } from '../domain/PetWorldAccess.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import type { PetWalletState, PetWorldState } from '../domain/PetWorldState.js';
import type { PetWorldTransaction } from './PetWorldTransaction.js';

export interface PetWorldOperationContext {
  readonly transaction: PetWorldTransaction;
  readonly actorId: string;
  readonly createdAt: string;
  readonly createId: (key: string) => string;
}

export type PetWorldCommandOf<Kind extends PetWorldMutationCommand['kind']> = Extract<
  PetWorldMutationCommand,
  { kind: Kind }
>;

export async function readOwnedWallet(
  transaction: PetWorldTransaction,
  actorId: string,
): Promise<PetWalletState> {
  const wallet = await transaction.readWallet(actorId);
  if (wallet) {
    return wallet;
  }
  if (
    (await transaction.readAccountRole(actorId)) !== AccountRole.STUDENT &&
    !(await transaction.hasOrganizationStudentEnrollment(actorId))
  ) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
  return { studentId: actorId, balance: 0n, revision: 0 };
}

export async function requireOwnedWallet(
  transaction: PetWorldTransaction,
  actorId: string,
): Promise<PetWalletState> {
  await readOwnedWallet(transaction, actorId);
  return await transaction.createWalletIfMissing(actorId);
}

export async function requireOwnedWorld(
  transaction: PetWorldTransaction,
  actorId: string,
  expectedRevision?: number,
): Promise<PetWorldState> {
  await requireOwnedWallet(transaction, actorId);
  const world = await transaction.readWorld(actorId);
  if (!world) {
    throw new PetWorldError(PetWorldFailure.INITIALIZATION_REQUIRED);
  }
  if (expectedRevision !== undefined && world.revision !== expectedRevision) {
    throw new PetWorldError(PetWorldFailure.STALE);
  }
  return world;
}

export async function requireOwnedClass(
  transaction: PetWorldTransaction,
  actorId: string,
  classId: string,
): Promise<void> {
  if (await transaction.canAdministerClass?.(actorId, classId)) {
    return;
  }
  requireTeacherClassAccess(
    actorId,
    await transaction.readClassRole(actorId, classId),
    await transaction.readClassAccess(classId),
  );
}

export async function requireClassMembership(
  transaction: PetWorldTransaction,
  actorId: string,
  classId: string,
): Promise<void> {
  const schoolClass = await transaction.readClassAccess(classId);
  if (!schoolClass || schoolClass.deleted || !(await transaction.isEnrolled(classId, actorId))) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
}

export async function requireInventoryItem(
  transaction: PetWorldTransaction,
  actorId: string,
  itemId: string | null,
): Promise<void> {
  if (
    itemId &&
    !(await transaction.listInventory(actorId)).some((item) => item.itemId === itemId)
  ) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
}

export function createWorldChangedReply(
  requestId: string,
  worldRevision: number | null,
  walletRevision: number | null = null,
): PetWorldMutationReply {
  return { kind: 'ok', requestId, worldRevision, walletRevision };
}
