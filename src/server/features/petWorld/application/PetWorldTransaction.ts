import type { AccountRole } from '#contracts/AccountRole.js';
import type { PetRecognition } from '#contracts/PetWorld.js';
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
} from '../domain/PetWorldState.js';

/** Transaction-scoped persistence only; no nested transaction, network, or Prisma surface. */
export interface PetWorldTransaction {
  readAccountRole(userId: string): Promise<AccountRole | null>;
  readClassAccess(classId: string): Promise<PetClassAccess | null>;
  listClassRoster(classId: string): Promise<PetRosterStudent[]>;
  isEnrolled(classId: string, studentId: string): Promise<boolean>;
  isClassContextValid(
    classId: string,
    classSessionId: string | null,
    activityId: string | null,
  ): Promise<boolean>;
  readReceipt(actorId: string, requestId: string): Promise<PetWorldReceipt | null>;
  saveReceipt(receipt: PetWorldReceipt): Promise<void>;
  readWallet(studentId: string): Promise<PetWalletState | null>;
  createWalletIfMissing(studentId: string): Promise<PetWalletState>;
  saveWallet(wallet: PetWalletState, expectedRevision: number): Promise<void>;
  appendWalletEntry(entry: PetWalletEntryState): Promise<void>;
  listWalletEntries(
    studentId: string,
    offset: number,
    limit: number,
  ): Promise<PetWalletEntryState[]>;
  saveRecognition(recognition: PetRecognitionState): Promise<void>;
  readRecognition(id: string): Promise<PetRecognitionState | null>;
  listOwnerRecognitions(
    studentId: string,
    offset: number,
    limit: number,
  ): Promise<PetRecognitionState[]>;
  readOwnerRecognitionRevision(studentId: string): Promise<number>;
  listClassRecognitions(classId: string, from: string, to: string): Promise<PetRecognitionState[]>;
  /** Counts distinct batches before the cutoff with at least one uncorrected recognition. */
  countClassroomMoments(classId: string, to: string): Promise<number>;
  saveCorrection(
    recognitionId: string,
    teacherId: string,
    correction: NonNullable<PetRecognition['correction']>,
  ): Promise<void>;
  readWorld(studentId: string): Promise<PetWorldState | null>;
  /** Lists cosmetic worlds with enabled consent and active enrollment in this class. */
  listSharedWorlds(classId: string): Promise<PetWorldState[]>;
  createWorldIfMissing(world: PetWorldState): Promise<PetWorldState>;
  saveWorld(world: PetWorldState, expectedRevision: number): Promise<void>;
  listInventory(studentId: string): Promise<PetInventoryState[]>;
  savePurchase(purchase: PetPurchaseState, inventory: PetInventoryState): Promise<void>;
  readHomeShare(studentId: string, classId: string): Promise<PetHomeShareState | null>;
  listHomeShares(studentId: string): Promise<PetHomeShareState[]>;
  saveHomeShare(share: PetHomeShareState, expectedRevision: number): Promise<void>;
}
