import { describe, expect, it } from 'vitest';
import { PetWorldFailure } from '#contracts/PetWorld.js';
import {
  calculateGrantedBalance,
  calculatePurchaseBalance,
  incrementPetRevision,
  parsePointAmount,
} from '../../../../src/server/features/petWorld/domain/PointAmount.js';

describe('whole point arithmetic', () => {
  it('preserves precision above JavaScript safe integers and accepts the full signed database range', () => {
    expect(parsePointAmount('9007199254740993')).toBe(9007199254740993n);
    expect(calculateGrantedBalance(0n, parsePointAmount('9223372036854775807'))).toBe(
      9223372036854775807n,
    );
    expect(calculatePurchaseBalance(9007199254740993n, 1n)).toBe(9007199254740992n);
  });

  it('rejects storage overflow, rounding and negative balances', () => {
    for (const value of ['0', '1.1', '-1', '01', ' 1', '1e3', '9223372036854775808']) {
      expect(() => parsePointAmount(value)).toThrow();
    }
    expect(() => calculateGrantedBalance(9223372036854775807n, 1n)).toThrow(
      expect.objectContaining({ code: PetWorldFailure.INVALID }),
    );
    expect(() => calculatePurchaseBalance(10n, 11n)).toThrow(
      expect.objectContaining({ code: PetWorldFailure.INSUFFICIENT_POINTS }),
    );
    expect(() => incrementPetRevision(Number.MAX_SAFE_INTEGER)).toThrow(
      expect.objectContaining({ code: PetWorldFailure.UNAVAILABLE }),
    );
  });
});
