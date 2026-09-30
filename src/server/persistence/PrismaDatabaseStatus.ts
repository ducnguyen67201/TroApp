import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { DatabaseStatus } from '../ports/DatabaseStatus.js';

export interface DatabaseStatusLogger {
  debug(details: { errorType: string }, message: string): void;
}

export interface DatabaseConnection extends DatabaseStatus {
  close(): Promise<void>;
}

function describeDatabaseFailure(error: unknown): { errorType: string } {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return { errorType: 'initialization' };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return { errorType: 'request' };
  }

  return { errorType: 'other' };
}

/** Owns Prisma and its pool; all generated database types remain behind this adapter. */
export function createPrismaDatabaseStatus(
  databaseUrl: string,
  logger: DatabaseStatusLogger,
): DatabaseConnection {
  const adapter = new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
  const client = new PrismaClient({ adapter });

  return {
    async isDatabaseReady(): Promise<boolean> {
      try {
        await client.outfitDraft.findFirst({ select: { id: true } });

        return true;
      } catch (error) {
        /* Log only the error category. Prisma messages can contain connection
           details, and readiness is a public endpoint. */
        logger.debug(describeDatabaseFailure(error), 'Database readiness check failed.');

        return false;
      }
    },
    async close(): Promise<void> {
      await client.$disconnect();
    },
  };
}
