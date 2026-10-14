import { createHash, randomUUID } from 'node:crypto';
import {
  PetWorldAssetId,
  PetWorldCommandKind,
  PetWorldCommandSchema,
  PetWorldFailure,
  isPetWorldMutationCommand,
  type PetWorldCommand,
  type PetWorldMutationCommand,
  type PetWorldMutationReply,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import { petCatalog } from '../domain/PetCatalog.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import { grantPoints } from './GrantPoints.js';
import { buyItem } from './BuyItem.js';
import { equipItem, initializeWorld, placeItem, setPetProfile } from './ChangeWorld.js';
import { correctRecognition } from './CorrectRecognition.js';
import { readOwnWorld } from './ReadWorld.js';
import { readClassRecognition, readOwnHistory } from './ReadHistory.js';
import { readNeighborhood, visitHome } from './ReadNeighborhood.js';
import {
  requireOwnedClass,
  readOwnedWallet,
  type PetWorldOperationContext,
} from './PetWorldOperation.js';
import type { PetWorldStore } from './PetWorldStore.js';
import type { PetWorldTransaction } from './PetWorldTransaction.js';
import type { PetWorldReceipt } from '../domain/PetWorldState.js';

function createCommandDigest(command: PetWorldMutationCommand): string {
  const content =
    command.kind === PetWorldCommandKind.GRANT_POINTS
      ? {
          kind: command.kind,
          requestId: command.requestId,
          classId: command.classId,
          studentIds: [...command.studentIds].sort(),
          pointsPerStudent: command.pointsPerStudent,
          category: command.category,
          note: command.note ?? '',
          classSessionId: command.classSessionId ?? null,
          activityId: command.activityId ?? null,
        }
      : command.kind === PetWorldCommandKind.BUY_ITEM
        ? {
            kind: command.kind,
            requestId: command.requestId,
            itemId: command.itemId,
            catalogRevision: command.catalogRevision,
            displayedPrice: command.displayedPrice,
            equipAfterPurchase: command.equipAfterPurchase,
            expectedWorldRevision: command.expectedWorldRevision ?? null,
            supportedAssetIds: [
              ...(command.supportedAssetIds ?? Object.values(PetWorldAssetId)),
            ].sort(),
          }
        : command;
  return createHash('sha256')
    .update(`v1:${JSON.stringify(content)}`)
    .digest('hex');
}

async function requireReceiptAccess(
  transaction: PetWorldTransaction,
  actorId: string,
  receipt: PetWorldReceipt,
): Promise<void> {
  if (receipt.actorId !== actorId) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
  if (receipt.classId) {
    await requireOwnedClass(transaction, actorId, receipt.classId);
  } else {
    await readOwnedWallet(transaction, actorId);
  }
}

async function readMutationClassId(
  transaction: PetWorldTransaction,
  command: PetWorldMutationCommand,
): Promise<string | null> {
  if (command.kind === PetWorldCommandKind.GRANT_POINTS) {
    return command.classId;
  }
  if (
    command.kind === PetWorldCommandKind.REVERSE_GRANT ||
    command.kind === PetWorldCommandKind.VOID_RECOGNITION
  ) {
    return (await transaction.readRecognition(command.recognitionId))?.classId ?? null;
  }
  return null;
}

async function executeMutation(
  context: PetWorldOperationContext,
  command: PetWorldMutationCommand,
): Promise<PetWorldMutationReply> {
  switch (command.kind) {
    case PetWorldCommandKind.GRANT_POINTS:
      return await grantPoints(context, command);
    case PetWorldCommandKind.BUY_ITEM:
      return await buyItem(context, command);
    case PetWorldCommandKind.INITIALIZE_WORLD:
      return await initializeWorld(context, command);
    case PetWorldCommandKind.SET_PET_PROFILE:
      return await setPetProfile(context, command);
    case PetWorldCommandKind.EQUIP_ITEM:
      return await equipItem(context, command);
    case PetWorldCommandKind.PLACE_ITEM:
      return await placeItem(context, command);
    case PetWorldCommandKind.REVERSE_GRANT:
    case PetWorldCommandKind.VOID_RECOGNITION:
      return await correctRecognition(context, command);
    case PetWorldCommandKind.SET_HOME_SHARING:
      /* Older desktops may retry this saved intent; it can no longer change visibility. */
      throw new PetWorldError(PetWorldFailure.INVALID);
  }
}

/** Application facade: operations own policy; the store owns atomicity and retry. */
export class PetWorldService {
  constructor(
    private readonly store: PetWorldStore,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async execute(actorId: string, input: PetWorldCommand): Promise<PetWorldReply> {
    const parsed = PetWorldCommandSchema.safeParse(input);
    if (!parsed.success || !actorId) {
      throw new PetWorldError(PetWorldFailure.INVALID);
    }
    const command = parsed.data;
    const createdAt = this.now().toISOString();
    const ids = new Map<string, string>();
    const createId = (key: string): string => {
      const existing = ids.get(key);
      if (existing) {
        return existing;
      }
      const id = this.createId();
      ids.set(key, id);
      return id;
    };
    return await this.store.runAtomically(async (transaction) => {
      if (isPetWorldMutationCommand(command)) {
        const digest = createCommandDigest(command);
        const receipt = await transaction.readReceipt(actorId, command.requestId);
        if (receipt) {
          await requireReceiptAccess(transaction, actorId, receipt);
          if (receipt.digest !== digest) {
            throw new PetWorldError(PetWorldFailure.REQUEST_CONFLICT);
          }
          return receipt.reply;
        }
        const result = await executeMutation(
          { transaction, actorId, createdAt, createId },
          command,
        );
        const classId = await readMutationClassId(transaction, command);
        await transaction.saveReceipt({
          actorId,
          requestId: command.requestId,
          digest,
          classId,
          reply: result,
        });
        return result;
      }
      switch (command.kind) {
        case PetWorldCommandKind.OWN_WORLD:
          return { kind: 'world', world: await readOwnWorld(transaction, actorId) };
        case PetWorldCommandKind.OWN_HISTORY:
          return await readOwnHistory(transaction, actorId, command);
        case PetWorldCommandKind.CATALOG: {
          if (!(await transaction.readAccountRole(actorId))) {
            throw new PetWorldError(PetWorldFailure.FORBIDDEN);
          }
          const world = await transaction.readWorld(actorId);
          const supportedAssets = command.supportedAssetIds ?? Object.values(PetWorldAssetId);
          return {
            kind: 'catalog',
            catalog: {
              revision: petCatalog.revision,
              items: petCatalog.items.filter(
                (item) =>
                  item.available &&
                  supportedAssets.includes(item.assetId) &&
                  (!world || item.petIds.includes(world.activePetId)),
              ),
            },
          };
        }
        case PetWorldCommandKind.CLASS_RECOGNITION:
          return await readClassRecognition(transaction, actorId, command);
        case PetWorldCommandKind.CLASS_NEIGHBORHOOD:
          return await readNeighborhood(transaction, actorId, command.classId, createdAt);
        case PetWorldCommandKind.VISIT_HOME:
          return await visitHome(transaction, actorId, command.classId, command.studentId);
        case PetWorldCommandKind.COMMAND_RESULT: {
          const receipt = await transaction.readReceipt(actorId, command.requestId);
          if (receipt) {
            await requireReceiptAccess(transaction, actorId, receipt);
          }
          return { kind: 'command-result', result: receipt?.reply ?? null };
        }
      }
    });
  }
}
