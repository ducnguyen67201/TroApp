import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../src/server/generated/prisma/client.js';
import {
  ClassroomTransactionConflict,
  ClassroomTransactionRetry,
  readClassroomTransactionConflict,
  runClassroomTransactionWithRetries,
  type ClassroomTransactionDiagnostic,
} from '../../../src/server/persistence/RetryClassroomTransaction.js';

function createCommitConflict() {
  return Object.assign(new Error('Driver commit failed'), {
    name: 'DriverAdapterError',
    cause: { kind: 'TransactionWriteConflict', privateDetails: 'never log this' },
  });
}

describe('classroom transaction retries', () => {
  it('recognizes query and adapter commit conflicts, without guessing from message text', () => {
    expect(
      readClassroomTransactionConflict(
        new Prisma.PrismaClientKnownRequestError('Conflict', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      ),
    ).toBe(ClassroomTransactionConflict.SERIALIZATION);
    expect(
      readClassroomTransactionConflict(
        new Prisma.PrismaClientKnownRequestError('Identity', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    ).toBe(ClassroomTransactionConflict.IDENTITY);
    expect(readClassroomTransactionConflict(createCommitConflict())).toBe(
      ClassroomTransactionConflict.SERIALIZATION,
    );
    expect(readClassroomTransactionConflict(new Error('TransactionWriteConflict'))).toBeNull();
    expect(
      readClassroomTransactionConflict(
        Object.assign(new Error('TransactionWriteConflict'), {
          name: 'DriverAdapterError',
          cause: { kind: 'AuthenticationFailed' },
        }),
      ),
    ).toBeNull();
    expect(
      readClassroomTransactionConflict({ name: 'DriverAdapterError', cause: null }),
    ).toBeNull();
  });

  it('reruns the whole owning transaction after commit failure and returns the successful result', async () => {
    const transaction = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(createCommitConflict())
      .mockResolvedValueOnce(7);
    const pause = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve());
    const log = vi.fn<(diagnostic: ClassroomTransactionDiagnostic) => void>();
    expect(
      await runClassroomTransactionWithRetries(
        transaction,
        { operation: 'fixture-transaction' },
        { pause, log },
      ),
    ).toBe(7);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledWith(ClassroomTransactionRetry.BASE_DELAY_MS);
    expect(log).not.toHaveBeenCalled();
  });

  it('bounds retries, emits only safe exhaustion fields and preserves the original failure', async () => {
    const error = createCommitConflict();
    const transaction = vi.fn<() => Promise<void>>().mockRejectedValue(error);
    const pause = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve());
    const log = vi.fn<(diagnostic: ClassroomTransactionDiagnostic) => void>();
    await expect(
      runClassroomTransactionWithRetries(
        transaction,
        { operation: 'classroom-retention', classId: 'class-fixture' },
        { pause, log },
      ),
    ).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(ClassroomTransactionRetry.MAX_ATTEMPTS);
    expect(log).toHaveBeenCalledWith({
      operation: 'classroom-retention',
      classId: 'class-fixture',
      stage: 'transaction-retry-exhausted',
      reason: ClassroomTransactionConflict.SERIALIZATION,
      attempts: ClassroomTransactionRetry.MAX_ATTEMPTS,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('privateDetails');
  });

  it('preserves the classroom stale refusal on exhaustion and never retries unrelated errors', async () => {
    const stale = new Error('stale');
    const pause = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve());
    const log = vi.fn<(diagnostic: ClassroomTransactionDiagnostic) => void>();
    const conflicting = vi.fn<() => Promise<void>>().mockRejectedValue(createCommitConflict());
    await expect(
      runClassroomTransactionWithRetries(
        conflicting,
        { operation: 'classroom-write' },
        { pause, log, createExhaustionError: () => stale },
      ),
    ).rejects.toBe(stale);
    const unauthorized = new Error('forbidden');
    const transaction = vi.fn<() => Promise<void>>().mockRejectedValue(unauthorized);
    await expect(
      runClassroomTransactionWithRetries(
        transaction,
        { operation: 'classroom-write' },
        { pause, log },
      ),
    ).rejects.toBe(unauthorized);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
