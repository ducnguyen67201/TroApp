import { z } from 'zod';
import { AccountRoleSchema } from '#contracts/AccountRole.js';
import {
  PetInventoryItemSchema,
  PetPointBalanceSchema,
  PetRecognitionSchema,
  PetWalletEntrySchema,
  PetWorldFailure,
  PetWorldMutationReplySchema,
  PetWorldProfileSchema,
} from '#contracts/PetWorld.js';
import type {
  PetInventoryItem,
  PetWallet,
  PetWalletEntry,
  PetWorld,
  PetWorldReceipt as StoredPetWorldReceipt,
  Prisma,
} from '../generated/prisma/client.js';
import { PetWorldError } from '../features/petWorld/domain/PetWorldError.js';
import type {
  PetInventoryState,
  PetRecognitionState,
  PetWalletEntryState,
  PetWalletState,
  PetWorldReceipt,
  PetWorldState,
} from '../features/petWorld/domain/PetWorldState.js';

export const PetReceiptScope = { CLASS: 'class', OWNER: 'owner' } as const;

const ReceiptScopeSchema = z.enum(PetReceiptScope);
const StoredRequestIdSchema = z.uuid();
const StoredDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Database revisions remain exact before crossing the public safe-integer boundary. */
export function readPetRevision(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PetWorldError(PetWorldFailure.UNAVAILABLE);
  }
  return Number(value);
}

export function readPetWalletRow(row: PetWallet): PetWalletState {
  return {
    studentId: row.studentId,
    balance: BigInt(PetPointBalanceSchema.parse(row.balance.toString())),
    revision: readPetRevision(row.revision),
  };
}

export function readPetWalletEntryRow(row: PetWalletEntry): PetWalletEntryState {
  const entry = PetWalletEntrySchema.parse({
    id: row.id,
    kind: row.kind,
    delta: row.delta.toString(),
    sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(),
  });
  return {
    ...entry,
    delta: BigInt(entry.delta),
    studentId: row.studentId,
    requestId: StoredRequestIdSchema.parse(row.requestId),
  };
}

export function readPetRecognitionRow(
  row: Prisma.PetRecognitionGetPayload<{ include: { correction: true } }>,
): PetRecognitionState {
  const recognition = PetRecognitionSchema.parse({
    id: row.id,
    classId: row.classId,
    teacherId: row.teacherId,
    studentId: row.studentId,
    batchId: row.batchId,
    points: row.amount.toString(),
    category: row.category,
    note: row.note ?? '',
    classSessionId: row.sessionId,
    activityId: row.activityId,
    createdAt: row.createdAt.toISOString(),
    correction: row.correction
      ? {
          kind: row.correction.kind,
          reason: row.correction.reason ?? 'Recognition corrected.',
          createdAt: row.correction.createdAt.toISOString(),
        }
      : null,
  });
  return { ...recognition, requestId: StoredRequestIdSchema.parse(row.requestId) };
}

export function readPetWorldRow(row: PetWorld): PetWorldState {
  const profile = PetWorldProfileSchema.parse(row.document);
  if (profile.revision !== readPetRevision(row.revision)) {
    throw new PetWorldError(PetWorldFailure.UNAVAILABLE);
  }
  return { ...profile, studentId: row.studentId };
}

export function readPetInventoryRow(row: PetInventoryItem): PetInventoryState {
  return {
    ...PetInventoryItemSchema.parse({
      itemId: row.itemId,
      purchaseId: row.purchaseId,
      acquiredAt: row.acquiredAt.toISOString(),
    }),
    studentId: row.studentId,
  };
}

export function readPetReceiptRow(row: StoredPetWorldReceipt): PetWorldReceipt {
  const scope = ReceiptScopeSchema.parse(row.scopeKind);
  if (scope === PetReceiptScope.OWNER && row.scopeId !== row.actorId) {
    throw new PetWorldError(PetWorldFailure.UNAVAILABLE);
  }
  return {
    actorId: row.actorId,
    requestId: StoredRequestIdSchema.parse(row.requestId),
    digest: StoredDigestSchema.parse(row.digest),
    classId: scope === PetReceiptScope.CLASS ? StoredRequestIdSchema.parse(row.scopeId) : null,
    reply: PetWorldMutationReplySchema.parse(row.reply),
  };
}

export function readPetAccountRole(role: unknown) {
  return AccountRoleSchema.parse(role);
}
