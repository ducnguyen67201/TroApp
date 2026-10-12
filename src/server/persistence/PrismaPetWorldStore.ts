import { z } from 'zod';
import { PrismaPg } from '@prisma/adapter-pg';
import { CourseContentSchema } from '#contracts/Classroom.js';
import {
  PetHomeShareSchema,
  PetInventoryItemSchema,
  PetPointAmountSchema,
  PetPointBalanceSchema,
  PetRecognitionCorrectionSchema,
  PetRecognitionSchema,
  PetWalletEntryKind,
  PetWalletEntrySchema,
  PetWorldFailure,
  PetWorldMutationReplySchema,
  PetWorldProfileSchema,
} from '#contracts/PetWorld.js';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { PetWorldStore } from '../features/petWorld/application/PetWorldStore.js';
import type { PetWorldTransaction } from '../features/petWorld/application/PetWorldTransaction.js';
import { PetWorldError } from '../features/petWorld/domain/PetWorldError.js';
import type {
  PetHomeShareState,
  PetInventoryState,
  PetPurchaseState,
  PetRecognitionState,
  PetWalletEntryState,
  PetWalletState,
  PetWorldReceipt,
  PetWorldState,
} from '../features/petWorld/domain/PetWorldState.js';
import { runClassroomTransactionWithRetries } from './RetryClassroomTransaction.js';
import {
  PetReceiptScope,
  readPetAccountRole,
  readPetHomeShareRow,
  readPetInventoryRow,
  readPetReceiptRow,
  readPetRecognitionRow,
  readPetWalletEntryRow,
  readPetWalletRow,
  readPetWorldRow,
} from './PetWorldRows.js';

const RequestIdSchema = z.uuid();
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** The callback receives only this scoped adapter, never a nested transaction runner. */
class PrismaPetWorldTransaction implements PetWorldTransaction {
  constructor(private readonly client: Prisma.TransactionClient) {}

  async readAccountRole(userId: string) {
    const row = await this.client.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return row ? readPetAccountRole(row.role) : null;
  }

  async readClassAccess(classId: string) {
    const row = await this.client.classroomGroup.findUnique({
      where: { id: classId },
      select: { id: true, teacherId: true, deletedAt: true },
    });
    return row ? { id: row.id, teacherId: row.teacherId, deleted: row.deletedAt !== null } : null;
  }

  async listClassRoster(classId: string) {
    const rows = await this.client.classroomEnrollment.findMany({
      where: { classId, active: true },
      include: { student: { select: { name: true, role: true } } },
      orderBy: { studentId: 'asc' },
    });
    return rows.map((row) => ({
      studentId: row.studentId,
      displayName: row.student.name,
      role: readPetAccountRole(row.student.role),
    }));
  }

  async isEnrolled(classId: string, studentId: string) {
    const row = await this.client.classroomEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId } },
      select: { active: true },
    });
    return row?.active ?? false;
  }

  async isClassContextValid(
    classId: string,
    classSessionId: string | null,
    activityId: string | null,
  ) {
    if (classSessionId !== null) {
      const meeting = await this.client.classroomMeeting.findUnique({
        where: { id: classSessionId },
        select: { classId: true },
      });
      if (!meeting || meeting.classId !== classId) {
        return false;
      }
    }
    if (activityId === null) {
      return true;
    }
    const schoolClass = await this.client.classroomGroup.findUnique({
      where: { id: classId },
      include: { courseRevision: { select: { content: true } } },
    });
    if (!schoolClass) {
      return false;
    }
    const content = CourseContentSchema.parse(schoolClass.courseRevision.content);
    return content.modules.some((module) =>
      module.lessons.some((lesson) =>
        lesson.activities.some((activity) => activity.id === activityId),
      ),
    );
  }

  async readReceipt(actorId: string, requestId: string) {
    const row = await this.client.petWorldReceipt.findUnique({
      where: { actorId_requestId: { actorId, requestId } },
    });
    return row ? readPetReceiptRow(row) : null;
  }

  async saveReceipt(receipt: PetWorldReceipt) {
    const reply = PetWorldMutationReplySchema.parse(receipt.reply);
    await this.client.petWorldReceipt.create({
      data: {
        actorId: receipt.actorId,
        requestId: RequestIdSchema.parse(receipt.requestId),
        digest: DigestSchema.parse(receipt.digest),
        scopeKind: receipt.classId === null ? PetReceiptScope.OWNER : PetReceiptScope.CLASS,
        scopeId: receipt.classId ?? receipt.actorId,
        reply,
      },
    });
  }

  async readWallet(studentId: string) {
    const row = await this.client.petWallet.findUnique({ where: { studentId } });
    return row ? readPetWalletRow(row) : null;
  }

  async readOwnerRecognitionRevision(studentId: string) {
    const corrections = await this.client.petRecognitionCorrection.count({
      where: { recognition: { studentId } },
    });
    const expiredNotes = await this.client.petRecognition.count({
      where: { studentId, note: null },
    });
    const expiredReasons = await this.client.petRecognitionCorrection.count({
      where: { recognition: { studentId }, reason: null },
    });
    return corrections + expiredNotes + expiredReasons;
  }

  async createWalletIfMissing(studentId: string) {
    const row = await this.client.petWallet.upsert({
      where: { studentId },
      create: { studentId },
      update: {},
    });
    return readPetWalletRow(row);
  }

  async saveWallet(wallet: PetWalletState, expectedRevision: number) {
    requireNextRevision(wallet.revision, expectedRevision);
    const balance = BigInt(PetPointBalanceSchema.parse(wallet.balance.toString()));
    const result = await this.client.petWallet.updateMany({
      where: { studentId: wallet.studentId, revision: BigInt(expectedRevision) },
      data: { balance, revision: BigInt(wallet.revision) },
    });
    requireUpdatedRow(result.count);
  }

  async appendWalletEntry(entry: PetWalletEntryState) {
    const validated = PetWalletEntrySchema.parse({
      id: entry.id,
      kind: entry.kind,
      delta: entry.delta.toString(),
      sourceId: entry.sourceId,
      createdAt: entry.createdAt,
    });
    await this.client.petWalletEntry.create({
      data: {
        ...validated,
        delta: BigInt(validated.delta),
        studentId: entry.studentId,
        requestId: RequestIdSchema.parse(entry.requestId),
        recognitionId: entry.kind === PetWalletEntryKind.PURCHASE ? null : entry.sourceId,
        purchaseId: entry.kind === PetWalletEntryKind.PURCHASE ? entry.sourceId : null,
        correctionId: entry.kind === PetWalletEntryKind.GRANT_REVERSAL ? entry.sourceId : null,
        createdAt: new Date(entry.createdAt),
      },
    });
  }

  async listWalletEntries(studentId: string, offset: number, limit: number) {
    const rows = await this.client.petWalletEntry.findMany({
      where: { studentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
    });
    return rows.map(readPetWalletEntryRow);
  }

  async saveRecognition(recognition: PetRecognitionState) {
    const validated = PetRecognitionSchema.parse({
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
    });
    if (validated.correction !== null) {
      throw new PetWorldError(PetWorldFailure.INVALID);
    }
    await this.client.petRecognition.create({
      data: {
        id: validated.id,
        classId: validated.classId,
        teacherId: validated.teacherId,
        studentId: validated.studentId,
        batchId: validated.batchId,
        requestId: RequestIdSchema.parse(recognition.requestId),
        amount: BigInt(validated.points),
        category: validated.category,
        note: validated.note,
        sessionId: validated.classSessionId,
        activityId: validated.activityId,
        createdAt: new Date(validated.createdAt),
      },
    });
  }

  async readRecognition(id: string) {
    const row = await this.client.petRecognition.findUnique({
      where: { id },
      include: { correction: true },
    });
    return row ? readPetRecognitionRow(row) : null;
  }

  async listOwnerRecognitions(studentId: string, offset: number, limit: number) {
    const rows = await this.client.petRecognition.findMany({
      where: { studentId },
      include: { correction: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
    });
    return rows.map(readPetRecognitionRow);
  }

  async listClassRecognitions(classId: string, from: string, to: string) {
    const rows = await this.client.petRecognition.findMany({
      where: { classId, createdAt: { gte: new Date(from), lt: new Date(to) } },
      include: { correction: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(readPetRecognitionRow);
  }

  async countClassroomMoments(classId: string, to: string) {
    const batches = await this.client.petRecognition.groupBy({
      by: ['batchId'],
      where: {
        classId,
        createdAt: { gte: new Date('1970-01-01T00:00:00.000Z'), lt: new Date(to) },
        correction: { is: null },
      },
    });
    return batches.length;
  }

  async saveCorrection(
    recognitionId: string,
    teacherId: string,
    correction: NonNullable<PetRecognitionState['correction']>,
  ) {
    const validated = PetRecognitionCorrectionSchema.parse(correction);
    await this.client.petRecognitionCorrection.create({
      data: {
        id: recognitionId,
        recognitionId,
        teacherId,
        kind: validated.kind,
        reason: validated.reason,
        createdAt: new Date(validated.createdAt),
      },
    });
  }

  async readWorld(studentId: string) {
    const row = await this.client.petWorld.findUnique({ where: { studentId } });
    return row ? readPetWorldRow(row) : null;
  }

  async listSharedWorlds(classId: string) {
    const rows = await this.client.petWorld.findMany({
      where: {
        student: {
          classEnrollments: { some: { classId, active: true } },
          petHomeShares: { some: { classId, enabled: true } },
        },
      },
      orderBy: { studentId: 'asc' },
    });
    return rows.map(readPetWorldRow);
  }

  async createWorldIfMissing(world: PetWorldState) {
    const document = readWorldDocument(world);
    if (document.revision !== 0) {
      throw new PetWorldError(PetWorldFailure.INVALID);
    }
    const row = await this.client.petWorld.upsert({
      where: { studentId: world.studentId },
      create: { studentId: world.studentId, revision: BigInt(document.revision), document },
      update: {},
    });
    return readPetWorldRow(row);
  }

  async saveWorld(world: PetWorldState, expectedRevision: number) {
    const document = readWorldDocument(world);
    requireNextRevision(document.revision, expectedRevision);
    const result = await this.client.petWorld.updateMany({
      where: { studentId: world.studentId, revision: BigInt(expectedRevision) },
      data: { revision: BigInt(document.revision), document },
    });
    requireUpdatedRow(result.count);
  }

  async listInventory(studentId: string) {
    const rows = await this.client.petInventoryItem.findMany({
      where: { studentId },
      orderBy: [{ acquiredAt: 'asc' }, { itemId: 'asc' }],
      take: 200,
    });
    return rows.map(readPetInventoryRow);
  }

  async savePurchase(purchase: PetPurchaseState, inventory: PetInventoryState) {
    const validated = PetInventoryItemSchema.parse({
      itemId: inventory.itemId,
      purchaseId: inventory.purchaseId,
      acquiredAt: inventory.acquiredAt,
    });
    if (
      purchase.studentId !== inventory.studentId ||
      purchase.itemId !== validated.itemId ||
      purchase.id !== validated.purchaseId
    ) {
      throw new PetWorldError(PetWorldFailure.INVALID);
    }
    await this.client.petPurchase.create({
      data: {
        id: purchase.id,
        studentId: purchase.studentId,
        itemId: purchase.itemId,
        amount: BigInt(PetPointAmountSchema.parse(purchase.points.toString())),
        catalogRevision: purchase.catalogRevision,
        requestId: RequestIdSchema.parse(purchase.requestId),
        createdAt: new Date(purchase.createdAt),
      },
    });
    await this.client.petInventoryItem.create({
      data: {
        ...validated,
        studentId: inventory.studentId,
        acquiredAt: new Date(validated.acquiredAt),
      },
    });
  }

  async readHomeShare(studentId: string, classId: string) {
    const row = await this.client.petHomeShare.findUnique({
      where: { studentId_classId: { studentId, classId } },
    });
    return row ? readPetHomeShareRow(row) : null;
  }

  async listHomeShares(studentId: string) {
    const rows = await this.client.petHomeShare.findMany({
      where: { studentId },
      orderBy: { classId: 'asc' },
    });
    return rows.map(readPetHomeShareRow);
  }

  async saveHomeShare(share: PetHomeShareState, expectedRevision: number) {
    const validated = PetHomeShareSchema.parse({
      classId: share.classId,
      enabled: share.enabled,
      revision: share.revision,
    });
    requireNextRevision(validated.revision, expectedRevision);
    const where = { studentId_classId: { studentId: share.studentId, classId: validated.classId } };
    if (expectedRevision === 0 && !(await this.client.petHomeShare.findUnique({ where }))) {
      await this.client.petHomeShare.create({
        data: { ...validated, studentId: share.studentId, revision: BigInt(validated.revision) },
      });
      return;
    }
    const result = await this.client.petHomeShare.updateMany({
      where: {
        studentId: share.studentId,
        classId: validated.classId,
        revision: BigInt(expectedRevision),
      },
      data: { enabled: validated.enabled, revision: BigInt(validated.revision) },
    });
    requireUpdatedRow(result.count);
  }
}

function requireUpdatedRow(count: number): void {
  if (count !== 1) {
    throw new PetWorldError(PetWorldFailure.STALE);
  }
}

function requireNextRevision(revision: number, expectedRevision: number): void {
  if (!Number.isSafeInteger(revision) || revision !== expectedRevision + 1) {
    throw new PetWorldError(PetWorldFailure.STALE);
  }
}

function readWorldDocument(world: PetWorldState) {
  return PetWorldProfileSchema.parse({
    activePetId: world.activePetId,
    names: world.names,
    slots: world.slots,
    backdropItemId: world.backdropItemId,
    outfitItemId: world.outfitItemId,
    revision: world.revision,
  });
}

/** Owns only transaction lifetime; all policy and authorization stay in the application feature. */
class PrismaPetWorldStore implements PetWorldStore {
  constructor(private readonly client: PrismaClient) {}

  runAtomically<T>(operation: (transaction: PetWorldTransaction) => Promise<T>): Promise<T> {
    return runClassroomTransactionWithRetries(
      () =>
        this.client.$transaction((client) => operation(new PrismaPetWorldTransaction(client)), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      { operation: 'pet-world-transaction' },
      { createExhaustionError: () => new PetWorldError(PetWorldFailure.UNAVAILABLE) },
    );
  }
}

export function createPrismaPetWorldStore(connectionString: string): {
  store: PetWorldStore;
  purgeExpiredSources(
    now: Date,
    retentionDays?: number,
  ): Promise<{ expired: number; more: boolean }>;
  close(): Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return {
    store: new PrismaPetWorldStore(client),
    purgeExpiredSources: (now, retentionDays) =>
      purgeExpiredPetWorldContent(client, now, retentionDays),
    close: () => client.$disconnect(),
  };
}

const PetWorldRetention = { BATCH_SIZE: 100, MILLISECONDS_PER_DAY: 86400000 } as const;

/** Scrub private prose in bounded transactions; accounting, entitlement and minimal receipts survive. */
async function purgeExpiredPetWorldContent(
  client: PrismaClient,
  now: Date,
  retentionDays: number | undefined,
): Promise<{ expired: number; more: boolean }> {
  if (retentionDays === undefined || !Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('An explicit recognition retention duration is required.');
  }
  const cutoff = new Date(now.getTime() - retentionDays * PetWorldRetention.MILLISECONDS_PER_DAY);
  return runClassroomTransactionWithRetries(
    () =>
      client.$transaction(
        async (transaction) => {
          const recognitions = await transaction.petRecognition.findMany({
            where: { createdAt: { lt: cutoff }, note: { not: null } },
            select: { id: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: PetWorldRetention.BATCH_SIZE,
          });
          const corrections = await transaction.petRecognitionCorrection.findMany({
            where: { createdAt: { lt: cutoff }, reason: { not: null } },
            select: { id: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: PetWorldRetention.BATCH_SIZE,
          });
          const removedNotes = await transaction.petRecognition.updateMany({
            where: { id: { in: recognitions.map((recognition) => recognition.id) } },
            data: { note: null },
          });
          const removedReasons = await transaction.petRecognitionCorrection.updateMany({
            where: { id: { in: corrections.map((correction) => correction.id) } },
            data: { reason: null },
          });
          return {
            expired: removedNotes.count + removedReasons.count,
            more:
              recognitions.length === PetWorldRetention.BATCH_SIZE ||
              corrections.length === PetWorldRetention.BATCH_SIZE,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    { operation: 'pet-world-retention' },
    { createExhaustionError: () => new PetWorldError(PetWorldFailure.UNAVAILABLE) },
  );
}
