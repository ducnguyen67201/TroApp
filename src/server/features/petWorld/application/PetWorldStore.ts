import type { PetWorldTransaction } from './PetWorldTransaction.js';

/** Owns one complete serializable transaction, including retries at commit. */
export interface PetWorldStore {
  runAtomically<T>(operation: (transaction: PetWorldTransaction) => Promise<T>): Promise<T>;
}
