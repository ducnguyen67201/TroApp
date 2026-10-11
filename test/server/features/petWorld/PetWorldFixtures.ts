import { AccountRole } from '#contracts/AccountRole.js';
import { PetWorldFailure, type PetRecognition } from '#contracts/PetWorld.js';
import type { PetWorldStore } from '../../../../src/server/features/petWorld/application/PetWorldStore.js';
import type { PetWorldTransaction } from '../../../../src/server/features/petWorld/application/PetWorldTransaction.js';
import { PetWorldError } from '../../../../src/server/features/petWorld/domain/PetWorldError.js';
import type {
  PetClassAccess,
  PetHomeShareState,
  PetInventoryState,
  PetPurchaseState,
  PetRecognitionState,
  PetRosterStudent,
  PetWalletEntryState,
  PetWalletState,
  PetWorldReceipt,
  PetWorldState,
} from '../../../../src/server/features/petWorld/domain/PetWorldState.js';

export const PetWorldFixtureIds = {
  CLASS: '11111111-1111-4111-8111-111111111111',
  OTHER_CLASS: '22222222-2222-4222-8222-222222222222',
  SESSION: '33333333-3333-4333-8333-333333333333',
  ACTIVITY: '44444444-4444-4444-8444-444444444444',
} as const;

/** A rollback-capable application fake; PostgreSQL tests own actual concurrency proof. */
export class MemoryPetWorldStore implements PetWorldStore, PetWorldTransaction {
  readonly roles = new Map<string, AccountRole>([
    ['teacher', AccountRole.TEACHER],
    ['other-teacher', AccountRole.TEACHER],
    ['student', AccountRole.STUDENT],
    ['partner', AccountRole.STUDENT],
  ]);
  readonly classes = new Map<string, PetClassAccess>([
    [
      PetWorldFixtureIds.CLASS,
      { id: PetWorldFixtureIds.CLASS, teacherId: 'teacher', deleted: false },
    ],
    [
      PetWorldFixtureIds.OTHER_CLASS,
      { id: PetWorldFixtureIds.OTHER_CLASS, teacherId: 'other-teacher', deleted: false },
    ],
  ]);
  readonly enrollments = new Set([
    `${PetWorldFixtureIds.CLASS}:student`,
    `${PetWorldFixtureIds.CLASS}:partner`,
  ]);
  wallets = new Map<string, PetWalletState>();
  entries = new Map<string, PetWalletEntryState>();
  recognitions = new Map<string, PetRecognitionState>();
  worlds = new Map<string, PetWorldState>();
  inventory = new Map<string, PetInventoryState>();
  purchases = new Map<string, PetPurchaseState>();
  shares = new Map<string, PetHomeShareState>();
  receipts = new Map<string, PetWorldReceipt>();
  failOnReceipt = false;

  async runAtomically<T>(operation: (transaction: PetWorldTransaction) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({
      wallets: this.wallets,
      entries: this.entries,
      recognitions: this.recognitions,
      worlds: this.worlds,
      inventory: this.inventory,
      purchases: this.purchases,
      shares: this.shares,
      receipts: this.receipts,
    });
    try {
      return await operation(this);
    } catch (error: unknown) {
      this.wallets = snapshot.wallets;
      this.entries = snapshot.entries;
      this.recognitions = snapshot.recognitions;
      this.worlds = snapshot.worlds;
      this.inventory = snapshot.inventory;
      this.purchases = snapshot.purchases;
      this.shares = snapshot.shares;
      this.receipts = snapshot.receipts;
      throw error;
    }
  }

  readAccountRole(userId: string): Promise<AccountRole | null> {
    return Promise.resolve(this.roles.get(userId) ?? null);
  }
  readClassAccess(classId: string): Promise<PetClassAccess | null> {
    return Promise.resolve(this.classes.get(classId) ?? null);
  }
  listClassRoster(classId: string): Promise<PetRosterStudent[]> {
    return Promise.resolve(
      [...this.roles]
        .filter(([id]) => this.enrollments.has(`${classId}:${id}`))
        .map(([studentId, role]) => ({ studentId, role, displayName: studentId })),
    );
  }
  isEnrolled(classId: string, studentId: string): Promise<boolean> {
    return Promise.resolve(this.enrollments.has(`${classId}:${studentId}`));
  }
  isClassContextValid(
    classId: string,
    classSessionId: string | null,
    activityId: string | null,
  ): Promise<boolean> {
    if (!classSessionId && !activityId) {
      return Promise.resolve(true);
    }
    return Promise.resolve(
      classId === PetWorldFixtureIds.CLASS &&
        (!classSessionId || classSessionId === PetWorldFixtureIds.SESSION) &&
        (!activityId || activityId === PetWorldFixtureIds.ACTIVITY),
    );
  }
  readReceipt(actorId: string, requestId: string): Promise<PetWorldReceipt | null> {
    return Promise.resolve(this.receipts.get(`${actorId}:${requestId}`) ?? null);
  }

  saveReceipt(receipt: PetWorldReceipt): Promise<void> {
    if (this.failOnReceipt) {
      throw new Error('Synthetic commit preparation failure.');
    }
    this.receipts.set(`${receipt.actorId}:${receipt.requestId}`, receipt);
    return Promise.resolve();
  }

  readWallet(studentId: string): Promise<PetWalletState | null> {
    return Promise.resolve(this.wallets.get(studentId) ?? null);
  }

  createWalletIfMissing(studentId: string): Promise<PetWalletState> {
    const wallet = this.wallets.get(studentId) ?? { studentId, balance: 0n, revision: 0 };
    this.wallets.set(studentId, wallet);
    return Promise.resolve(wallet);
  }

  saveWallet(wallet: PetWalletState, expectedRevision: number): Promise<void> {
    if (this.wallets.get(wallet.studentId)?.revision !== expectedRevision) {
      throw new PetWorldError(PetWorldFailure.STALE);
    }
    this.wallets.set(wallet.studentId, wallet);
    return Promise.resolve();
  }

  appendWalletEntry(entry: PetWalletEntryState): Promise<void> {
    this.entries.set(entry.id, entry);
    return Promise.resolve();
  }
  listWalletEntries(
    studentId: string,
    offset: number,
    limit: number,
  ): Promise<PetWalletEntryState[]> {
    return Promise.resolve(
      [...this.entries.values()]
        .filter((entry) => entry.studentId === studentId)
        .reverse()
        .slice(offset, offset + limit),
    );
  }
  saveRecognition(recognition: PetRecognitionState): Promise<void> {
    this.recognitions.set(recognition.id, recognition);
    return Promise.resolve();
  }
  readRecognition(id: string): Promise<PetRecognitionState | null> {
    return Promise.resolve(this.recognitions.get(id) ?? null);
  }
  listOwnerRecognitions(
    studentId: string,
    offset: number,
    limit: number,
  ): Promise<PetRecognitionState[]> {
    return Promise.resolve(
      [...this.recognitions.values()]
        .filter((recognition) => recognition.studentId === studentId)
        .reverse()
        .slice(offset, offset + limit),
    );
  }
  readOwnerRecognitionRevision(studentId: string): Promise<number> {
    return Promise.resolve(
      [...this.recognitions.values()].filter(
        (recognition) => recognition.studentId === studentId && recognition.correction,
      ).length,
    );
  }
  listClassRecognitions(classId: string, from: string, to: string): Promise<PetRecognitionState[]> {
    return Promise.resolve(
      [...this.recognitions.values()]
        .filter(
          (recognition) =>
            recognition.classId === classId &&
            recognition.createdAt >= from &&
            recognition.createdAt < to,
        )
        .reverse(),
    );
  }

  saveCorrection(
    recognitionId: string,
    teacherId: string,
    correction: NonNullable<PetRecognition['correction']>,
  ): Promise<void> {
    const recognition = this.recognitions.get(recognitionId);
    if (!recognition || recognition.teacherId !== teacherId || recognition.correction) {
      throw new PetWorldError(PetWorldFailure.REVERSAL_UNAVAILABLE);
    }
    this.recognitions.set(recognitionId, { ...recognition, correction });
    return Promise.resolve();
  }

  readWorld(studentId: string): Promise<PetWorldState | null> {
    return Promise.resolve(this.worlds.get(studentId) ?? null);
  }

  createWorldIfMissing(world: PetWorldState): Promise<PetWorldState> {
    const existing = this.worlds.get(world.studentId);
    if (existing) {
      return Promise.resolve(existing);
    }
    this.worlds.set(world.studentId, world);
    return Promise.resolve(world);
  }

  saveWorld(world: PetWorldState, expectedRevision: number): Promise<void> {
    if (this.worlds.get(world.studentId)?.revision !== expectedRevision) {
      throw new PetWorldError(PetWorldFailure.STALE);
    }
    this.worlds.set(world.studentId, world);
    return Promise.resolve();
  }

  listInventory(studentId: string): Promise<PetInventoryState[]> {
    return Promise.resolve(
      [...this.inventory.values()].filter((item) => item.studentId === studentId),
    );
  }

  savePurchase(purchase: PetPurchaseState, inventory: PetInventoryState): Promise<void> {
    if (this.inventory.has(`${inventory.studentId}:${inventory.itemId}`)) {
      throw new PetWorldError(PetWorldFailure.ALREADY_OWNED);
    }
    this.purchases.set(purchase.id, purchase);
    this.inventory.set(`${inventory.studentId}:${inventory.itemId}`, inventory);
    return Promise.resolve();
  }

  readHomeShare(studentId: string, classId: string): Promise<PetHomeShareState | null> {
    return Promise.resolve(this.shares.get(`${studentId}:${classId}`) ?? null);
  }
  listHomeShares(studentId: string): Promise<PetHomeShareState[]> {
    return Promise.resolve(
      [...this.shares.values()].filter((share) => share.studentId === studentId),
    );
  }

  saveHomeShare(share: PetHomeShareState, expectedRevision: number): Promise<void> {
    if (
      (this.shares.get(`${share.studentId}:${share.classId}`)?.revision ?? 0) !== expectedRevision
    ) {
      throw new PetWorldError(PetWorldFailure.STALE);
    }
    this.shares.set(`${share.studentId}:${share.classId}`, share);
    return Promise.resolve();
  }
}
