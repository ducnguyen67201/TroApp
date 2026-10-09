import { setTimeout as waitForRetry } from 'node:timers/promises';
import { Prisma } from '../generated/prisma/client.js';

export const ClassroomTransactionConflict = {
  SERIALIZATION: 'serialization',
  IDENTITY: 'identity',
} as const;

export type ClassroomTransactionConflict =
  (typeof ClassroomTransactionConflict)[keyof typeof ClassroomTransactionConflict];

export const ClassroomTransactionRetry = { MAX_ATTEMPTS: 3, BASE_DELAY_MS: 10 } as const;

export interface ClassroomTransactionDiagnostic {
  operation: string;
  classId?: string;
  stage: 'transaction-retry-exhausted';
  reason: ClassroomTransactionConflict;
  attempts: number;
}

export interface ClassroomTransactionRetryOptions {
  log?: (diagnostic: ClassroomTransactionDiagnostic) => void;
  pause?: (delayMs: number) => Promise<void>;
  createExhaustionError?: () => Error;
}

/** PostgreSQL 40001/40P01 may surface at commit as an adapter Error, outside Prisma's query wrapper. */
export function readClassroomTransactionConflict(
  error: unknown,
): ClassroomTransactionConflict | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
      return ClassroomTransactionConflict.SERIALIZATION;
    }
    if (error.code === 'P2002') {
      return ClassroomTransactionConflict.IDENTITY;
    }
  }
  if (error instanceof Error && error.name === 'DriverAdapterError') {
    const cause: unknown = error.cause;
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'kind' in cause &&
      cause.kind === 'TransactionWriteConflict'
    ) {
      return ClassroomTransactionConflict.SERIALIZATION;
    }
  }
  return null;
}

/** Retry only the complete database transaction callback, including commit; external provider work stays outside. */
export async function runClassroomTransactionWithRetries<T>(
  operation: () => Promise<T>,
  context: { operation: string; classId?: string },
  options: ClassroomTransactionRetryOptions = {},
): Promise<T> {
  const pause = options.pause ?? ((delayMs: number) => waitForRetry(delayMs));
  const log =
    options.log ??
    ((diagnostic: ClassroomTransactionDiagnostic) => {
      console.warn(diagnostic);
    });
  for (let attempt = 1; attempt <= ClassroomTransactionRetry.MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      const reason = readClassroomTransactionConflict(error);
      if (reason === null) {
        throw error;
      }
      if (attempt === ClassroomTransactionRetry.MAX_ATTEMPTS) {
        log({ ...context, stage: 'transaction-retry-exhausted', reason, attempts: attempt });
        throw options.createExhaustionError ? options.createExhaustionError() : error;
      }
      await pause(ClassroomTransactionRetry.BASE_DELAY_MS * attempt);
    }
  }
  throw new Error('Unreachable transaction retry state.');
}
