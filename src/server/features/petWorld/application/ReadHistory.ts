import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  PetWorldCommandKind,
  PetWorldFailure,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import { calculateRecognitionCoverage } from '../domain/RecognitionCoverage.js';
import { PetWorldError } from '../domain/PetWorldError.js';
import type { PetWorldTransaction } from './PetWorldTransaction.js';
import { requireOwnedClass, readOwnedWallet } from './PetWorldOperation.js';
import { buildRecognitionView, buildWalletEntryView } from './ReadWorld.js';

const CursorSchema = z.strictObject({
  actorId: z.string(),
  scope: z.string(),
  revision: z.string(),
  offset: z.number().int().nonnegative().max(1_000_000_000),
});

function readPageOffset(
  cursor: string | undefined,
  actorId: string,
  scope: string,
  revision: string,
): number {
  if (!cursor) {
    return 0;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new PetWorldError(PetWorldFailure.INVALID);
  }
  const parsed = CursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.actorId !== actorId || parsed.data.scope !== scope) {
    throw new PetWorldError(PetWorldFailure.INVALID);
  }
  if (parsed.data.revision !== revision) {
    throw new PetWorldError(PetWorldFailure.STALE);
  }
  return parsed.data.offset;
}

function createPageCursor(
  actorId: string,
  scope: string,
  revision: string,
  offset: number,
): string {
  return Buffer.from(JSON.stringify({ actorId, scope, revision, offset })).toString('base64url');
}

export async function readOwnHistory(
  transaction: PetWorldTransaction,
  actorId: string,
  command: Extract<PetWorldCommand, { kind: typeof PetWorldCommandKind.OWN_HISTORY }>,
): Promise<PetWorldReply> {
  const wallet = await readOwnedWallet(transaction, actorId);
  const recognitionRevision = await transaction.readOwnerRecognitionRevision(actorId);
  const revision = `${wallet.revision.toString()}:${recognitionRevision.toString()}`;
  const offset = readPageOffset(command.cursor, actorId, 'owner-history', revision);
  const limit = command.limit ?? 50;
  const entries = await transaction.listWalletEntries(actorId, offset, limit + 1);
  const recognitions = await transaction.listOwnerRecognitions(actorId, offset, limit + 1);
  return {
    kind: 'history',
    walletRevision: wallet.revision,
    entries: entries.slice(0, limit).map(buildWalletEntryView),
    recognitions: recognitions.slice(0, limit).map(buildRecognitionView),
    nextCursor:
      entries.length > limit || recognitions.length > limit
        ? createPageCursor(actorId, 'owner-history', revision, offset + limit)
        : null,
  };
}

export async function readClassRecognition(
  transaction: PetWorldTransaction,
  actorId: string,
  command: Extract<PetWorldCommand, { kind: typeof PetWorldCommandKind.CLASS_RECOGNITION }>,
): Promise<PetWorldReply> {
  await requireOwnedClass(transaction, actorId, command.classId);
  const roster = await transaction.listClassRoster(command.classId);
  const records = await transaction.listClassRecognitions(
    command.classId,
    command.from,
    command.to,
  );
  const scope = JSON.stringify([command.classId, command.from, command.to]);
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        records: records.map((record) => [record.id, record.note, record.correction]),
        roster,
      }),
    )
    .digest('hex');
  const offset = readPageOffset(command.cursor, actorId, scope, revision);
  const limit = command.limit ?? 100;
  return {
    kind: 'class-recognition',
    classId: command.classId,
    from: command.from,
    to: command.to,
    roster: roster
      .filter((student) => student.role === AccountRole.STUDENT)
      .map((student) => ({ studentId: student.studentId, displayName: student.displayName })),
    recognitions: records.slice(offset, offset + limit).map(buildRecognitionView),
    coverage: calculateRecognitionCoverage(roster, records),
    nextCursor:
      records.length > offset + limit
        ? createPageCursor(actorId, scope, revision, offset + limit)
        : null,
  };
}
