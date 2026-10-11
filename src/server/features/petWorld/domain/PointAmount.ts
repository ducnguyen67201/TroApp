import { PetWorldFailure, PetWorldLimits } from '#contracts/PetWorld.js';
import { PetWorldError } from './PetWorldError.js';

const maximumPoints = BigInt(PetWorldLimits.MAX_POINTS);

export function parsePointAmount(value: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    throw new PetWorldError(PetWorldFailure.INVALID);
  }
  const points = BigInt(value);
  if (points > maximumPoints) {
    throw new PetWorldError(PetWorldFailure.INVALID);
  }
  return points;
}

export function calculateGrantedBalance(balance: bigint, points: bigint): bigint {
  const updated = balance + points;
  if (balance < 0n || points <= 0n || updated > maximumPoints) {
    throw new PetWorldError(PetWorldFailure.INVALID);
  }
  return updated;
}

export function calculatePurchaseBalance(balance: bigint, points: bigint): bigint {
  if (points <= 0n || balance < points) {
    throw new PetWorldError(PetWorldFailure.INSUFFICIENT_POINTS);
  }
  return balance - points;
}

export function incrementPetRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new PetWorldError(PetWorldFailure.UNAVAILABLE);
  }
  return revision + 1;
}
