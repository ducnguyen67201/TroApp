import {
  PetEquipmentSlot,
  PetItemCategory,
  PetWalletEntryKind,
  PetWorldAssetId,
  PetWorldCommandKind,
  PetWorldFailure,
  type PetWorldMutationReply,
} from '#contracts/PetWorld.js';
import { findCatalogItem, petCatalog, requireItemCompatibility } from '../domain/PetCatalog.js';
import {
  calculatePurchaseBalance,
  incrementPetRevision,
  parsePointAmount,
} from '../domain/PointAmount.js';
import { changeHomeSlot, changePetEquipment } from '../domain/PetAppearance.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import {
  createWorldChangedReply,
  requireOwnedWallet,
  requireOwnedWorld,
  type PetWorldCommandOf,
  type PetWorldOperationContext,
} from './PetWorldOperation.js';

/** Price, debit, permanent entitlement and optional appearance form one atomic intent. */
export async function buyItem(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<typeof PetWorldCommandKind.BUY_ITEM>,
): Promise<PetWorldMutationReply> {
  const { transaction, actorId, createdAt, createId } = context;
  const world = await requireOwnedWorld(
    transaction,
    actorId,
    command.equipAfterPurchase ? command.expectedWorldRevision : undefined,
  );
  const wallet = await requireOwnedWallet(transaction, actorId);
  const item = findCatalogItem(command.itemId);
  if (
    !item.available ||
    command.catalogRevision !== petCatalog.revision ||
    command.displayedPrice !== item.price
  ) {
    throw new PetWorldError(PetWorldFailure.STALE_CATALOG);
  }
  requireItemCompatibility(item, world.activePetId);
  if (!(command.supportedAssetIds ?? Object.values(PetWorldAssetId)).includes(item.assetId)) {
    throw new PetWorldError(PetWorldFailure.INCOMPATIBLE_ITEM);
  }
  if ((await transaction.listInventory(actorId)).some((owned) => owned.itemId === item.id)) {
    throw new PetWorldError(PetWorldFailure.ALREADY_OWNED);
  }
  const points = parsePointAmount(item.price);
  const purchaseId = createId('purchase');
  const walletRevision = incrementPetRevision(wallet.revision);
  await transaction.saveWallet(
    {
      ...wallet,
      balance: calculatePurchaseBalance(wallet.balance, points),
      revision: walletRevision,
    },
    wallet.revision,
  );
  await transaction.savePurchase(
    {
      id: purchaseId,
      studentId: actorId,
      itemId: item.id,
      points,
      catalogRevision: petCatalog.revision,
      requestId: command.requestId,
      createdAt,
    },
    { studentId: actorId, itemId: item.id, purchaseId, acquiredAt: createdAt },
  );
  await transaction.appendWalletEntry({
    id: createId('entry'),
    studentId: actorId,
    kind: PetWalletEntryKind.PURCHASE,
    delta: -points,
    sourceId: purchaseId,
    requestId: command.requestId,
    createdAt,
  });
  if (!command.equipAfterPurchase) {
    return createWorldChangedReply(command.requestId, null, walletRevision);
  }
  const changed = item.slot
    ? changeHomeSlot(world, item.slot, item.id)
    : changePetEquipment(
        world,
        item.category === PetItemCategory.BACKDROP
          ? PetEquipmentSlot.BACKDROP
          : PetEquipmentSlot.OUTFIT,
        item.id,
      );
  const worldRevision = incrementPetRevision(world.revision);
  await transaction.saveWorld(
    { ...changed, studentId: actorId, revision: worldRevision },
    world.revision,
  );
  return createWorldChangedReply(command.requestId, worldRevision, walletRevision);
}
