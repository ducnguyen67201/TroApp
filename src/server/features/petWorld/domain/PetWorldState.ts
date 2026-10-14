import type { AccountRole } from '#contracts/AccountRole.js';
import type {
  PetInventoryItem,
  PetRecognition,
  PetWorldMutationReply,
  PetWorldProfile,
  PetWalletEntryKind,
} from '#contracts/PetWorld.js';

export interface PetWalletState {
  readonly studentId: string;
  readonly balance: bigint;
  readonly revision: number;
}

export interface PetWorldState extends PetWorldProfile {
  readonly studentId: string;
}

/** Classmate-visible identity and cosmetics; wallet and recognition fields stay private. */
export interface PetClassWorld extends PetWorldState {
  readonly ownerName: string;
}

export interface PetWalletEntryState {
  readonly id: string;
  readonly studentId: string;
  readonly kind: PetWalletEntryKind;
  readonly delta: bigint;
  readonly sourceId: string;
  readonly requestId: string;
  readonly createdAt: string;
}

export interface PetRecognitionState extends PetRecognition {
  readonly requestId: string;
}

export interface PetPurchaseState {
  readonly id: string;
  readonly studentId: string;
  readonly itemId: string;
  readonly points: bigint;
  readonly catalogRevision: string;
  readonly requestId: string;
  readonly createdAt: string;
}

export interface PetInventoryState extends PetInventoryItem {
  readonly studentId: string;
}

export interface PetWorldReceipt {
  readonly actorId: string;
  readonly requestId: string;
  readonly digest: string;
  readonly classId: string | null;
  readonly reply: PetWorldMutationReply;
}

export interface PetClassAccess {
  readonly id: string;
  readonly teacherId: string;
  readonly teacherIds?: readonly string[];
  readonly deleted: boolean;
}

export interface PetRosterStudent {
  readonly studentId: string;
  readonly displayName: string;
  readonly role: AccountRole;
}
