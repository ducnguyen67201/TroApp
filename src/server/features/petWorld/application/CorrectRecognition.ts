import {
  PetCorrectionKind,
  PetWalletEntryKind,
  PetWorldCommandKind,
  PetWorldFailure,
  type PetWorldMutationReply,
} from '#contracts/PetWorld.js';
import {
  calculatePurchaseBalance,
  incrementPetRevision,
  parsePointAmount,
} from '../domain/PointAmount.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import {
  requireOwnedClass,
  type PetWorldCommandOf,
  type PetWorldOperationContext,
} from './PetWorldOperation.js';

export async function correctRecognition(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<
    typeof PetWorldCommandKind.REVERSE_GRANT | typeof PetWorldCommandKind.VOID_RECOGNITION
  >,
): Promise<PetWorldMutationReply> {
  const { transaction, actorId, createdAt } = context;
  const recognition = await transaction.readRecognition(command.recognitionId);
  if (
    !recognition ||
    (recognition.teacherId !== actorId &&
      !(await transaction.canAdministerClass?.(actorId, recognition.classId)))
  ) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
  await requireOwnedClass(transaction, actorId, recognition.classId);
  if (recognition.correction) {
    throw new PetWorldError(PetWorldFailure.REVERSAL_UNAVAILABLE);
  }
  const reversed = command.kind === PetWorldCommandKind.REVERSE_GRANT;
  const correction = {
    kind: reversed ? PetCorrectionKind.REVERSED : PetCorrectionKind.VOIDED,
    reason: command.reason,
    createdAt,
  };
  if (reversed) {
    const wallet = await transaction.readWallet(recognition.studentId);
    if (!wallet) {
      throw new PetWorldError(PetWorldFailure.REVERSAL_UNAVAILABLE);
    }
    const points = parsePointAmount(recognition.points);
    await transaction.saveWallet(
      {
        ...wallet,
        balance: calculatePurchaseBalance(wallet.balance, points),
        revision: incrementPetRevision(wallet.revision),
      },
      wallet.revision,
    );
    await transaction.saveCorrection(recognition.id, actorId, correction);
    await transaction.appendWalletEntry({
      id: context.createId('entry'),
      studentId: recognition.studentId,
      kind: PetWalletEntryKind.GRANT_REVERSAL,
      delta: -points,
      sourceId: recognition.id,
      requestId: command.requestId,
      createdAt,
    });
  } else {
    await transaction.saveCorrection(recognition.id, actorId, correction);
  }
  return {
    kind: 'corrected',
    requestId: command.requestId,
    recognitionId: recognition.id,
    correction: { kind: correction.kind, createdAt: correction.createdAt },
  };
}
