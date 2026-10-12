import {
  PetWorldCommandKind,
  PetWorldFailure,
  type PetWorldMutationReply,
} from '#contracts/PetWorld.js';
import { incrementPetRevision } from '../domain/PointAmount.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import {
  requireClassMembership,
  requireOwnedWorld,
  type PetWorldCommandOf,
  type PetWorldOperationContext,
} from './PetWorldOperation.js';

export async function setHomeSharing(
  context: PetWorldOperationContext,
  command: PetWorldCommandOf<typeof PetWorldCommandKind.SET_HOME_SHARING>,
): Promise<PetWorldMutationReply> {
  await requireOwnedWorld(context.transaction, context.actorId);
  await requireClassMembership(context.transaction, context.actorId, command.classId);
  const existing = await context.transaction.readHomeShare(context.actorId, command.classId);
  const revision = existing?.revision ?? 0;
  if (revision !== command.expectedShareRevision) {
    throw new PetWorldError(PetWorldFailure.STALE);
  }
  const share = {
    studentId: context.actorId,
    classId: command.classId,
    enabled: command.enabled,
    revision: incrementPetRevision(revision),
  };
  await context.transaction.saveHomeShare(share, revision);
  return {
    kind: 'shared',
    requestId: command.requestId,
    share: { classId: share.classId, enabled: share.enabled, revision: share.revision },
  };
}
