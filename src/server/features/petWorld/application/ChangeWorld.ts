import { PetWorldCommandKind, type PetWorldMutationReply } from '#contracts/PetWorld.js';
import { changeHomeSlot, changePetEquipment, changePetProfile } from '../domain/PetAppearance.js';
import { incrementPetRevision } from '../domain/PointAmount.js';
import {
  createWorldChangedReply,
  requireInventoryItem,
  requireOwnedWallet,
  requireOwnedWorld,
  type PetWorldCommandOf,
  type PetWorldOperationContext,
} from './PetWorldOperation.js';

export async function initializeWorld(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<typeof PetWorldCommandKind.INITIALIZE_WORLD>,
): Promise<PetWorldMutationReply> {
  const wallet = await requireOwnedWallet(context.transaction, context.actorId);
  const world = await context.transaction.createWorldIfMissing({
    studentId: context.actorId,
    activePetId: command.activePetId,
    names: command.names,
    backdropItemId: null,
    outfitItemId: null,
    slots: { garden: null, home: null, feature: null },
    revision: 0,
  });
  return createWorldChangedReply(command.requestId, world.revision, wallet.revision);
}

export async function setPetProfile(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<typeof PetWorldCommandKind.SET_PET_PROFILE>,
): Promise<PetWorldMutationReply> {
  const world = await requireOwnedWorld(
    context.transaction,
    context.actorId,
    command.expectedWorldRevision,
  );
  const changed = changePetProfile(world, command.activePetId, command.name);
  const revision = incrementPetRevision(world.revision);
  await context.transaction.saveWorld(
    { ...changed, studentId: context.actorId, revision },
    world.revision,
  );
  return createWorldChangedReply(command.requestId, revision);
}

export async function equipItem(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<typeof PetWorldCommandKind.EQUIP_ITEM>,
): Promise<PetWorldMutationReply> {
  const world = await requireOwnedWorld(
    context.transaction,
    context.actorId,
    command.expectedWorldRevision,
  );
  await requireInventoryItem(context.transaction, context.actorId, command.itemId);
  const changed = changePetEquipment(world, command.slot, command.itemId);
  const revision = incrementPetRevision(world.revision);
  await context.transaction.saveWorld(
    { ...changed, studentId: context.actorId, revision },
    world.revision,
  );
  return createWorldChangedReply(command.requestId, revision);
}

export async function placeItem(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<typeof PetWorldCommandKind.PLACE_ITEM>,
): Promise<PetWorldMutationReply> {
  const world = await requireOwnedWorld(
    context.transaction,
    context.actorId,
    command.expectedWorldRevision,
  );
  await requireInventoryItem(context.transaction, context.actorId, command.itemId);
  const changed = changeHomeSlot(world, command.slot, command.itemId);
  const revision = incrementPetRevision(world.revision);
  await context.transaction.saveWorld(
    { ...changed, studentId: context.actorId, revision },
    world.revision,
  );
  return createWorldChangedReply(command.requestId, revision);
}
