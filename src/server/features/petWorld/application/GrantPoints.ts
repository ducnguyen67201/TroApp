import {
  PetWalletEntryKind,
  PetWorldCommandKind,
  PetWorldFailure,
  type PetWorldMutationReply,
} from '#contracts/PetWorld.js';
import { requireTeacherGrantRecipients } from '../domain/PetWorldAccess.js';
import {
  calculateGrantedBalance,
  incrementPetRevision,
  parsePointAmount,
} from '../domain/PointAmount.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import {
  requireOwnedClass,
  type PetWorldCommandOf,
  type PetWorldOperationContext,
} from './PetWorldOperation.js';

/** The only operation that creates positive points; every recipient commits together. */
export async function grantPoints(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<typeof PetWorldCommandKind.GRANT_POINTS>,
): Promise<PetWorldMutationReply> {
  const { transaction, actorId, createdAt, createId } = context;
  await requireOwnedClass(transaction, actorId, command.classId);
  requireTeacherGrantRecipients(
    actorId,
    command.studentIds,
    await transaction.listClassRoster(command.classId),
  );
  if (
    !(await transaction.isClassContextValid(
      command.classId,
      command.classSessionId ?? null,
      command.activityId ?? null,
    ))
  ) {
    throw new PetWorldError(PetWorldFailure.FORBIDDEN);
  }
  const points = parsePointAmount(command.pointsPerStudent);
  const batchId = createId('batch');
  const recognitions: Extract<PetWorldMutationReply, { kind: 'granted' }>['recognitions'] = [];
  for (const studentId of [...command.studentIds].sort()) {
    const wallet = await transaction.createWalletIfMissing(studentId);
    const id = createId(`recognition:${studentId}`);
    await transaction.saveRecognition({
      id,
      classId: command.classId,
      teacherId: actorId,
      studentId,
      batchId,
      points: command.pointsPerStudent,
      category: command.category,
      note: command.note ?? '',
      classSessionId: command.classSessionId ?? null,
      activityId: command.activityId ?? null,
      createdAt,
      correction: null,
      requestId: command.requestId,
    });
    await transaction.saveWallet(
      {
        ...wallet,
        balance: calculateGrantedBalance(wallet.balance, points),
        revision: incrementPetRevision(wallet.revision),
      },
      wallet.revision,
    );
    await transaction.appendWalletEntry({
      id: createId(`entry:${studentId}`),
      studentId,
      kind: PetWalletEntryKind.TEACHER_GRANT,
      delta: points,
      sourceId: id,
      requestId: command.requestId,
      createdAt,
    });
    recognitions.push({ id, studentId, points: command.pointsPerStudent });
  }
  return { kind: 'granted', requestId: command.requestId, batchId, createdAt, recognitions };
}
