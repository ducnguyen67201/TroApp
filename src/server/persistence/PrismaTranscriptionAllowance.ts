import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type {
  TranscriptionAllowance,
  TranscriptionReservation,
} from '../features/transcription/ports/TranscriptionAllowance.js';

/** Reserve the full capture cap before opening a paid upstream. Crashes retain
 * that charge conservatively; normal close refunds unused samples exactly once. */
export function createPrismaTranscriptionAllowance(
  databaseUrl: string,
): TranscriptionAllowance & { close(): Promise<void> } {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  async function reserveTranscription(reservation: TranscriptionReservation): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.$transaction(
          async (transaction) => {
            const now = new Date();
            const day = new Date(now.toISOString().slice(0, 10));
            await transaction.transcriptionCapture.updateMany({
              where: { activeUserId: reservation.userId, expiresAt: { lte: now } },
              data: { activeUserId: null },
            });
            await transaction.transcriptionCapture.deleteMany({
              where: {
                userId: reservation.userId,
                activeUserId: null,
                expiresAt: { lt: new Date(now.getTime() - 86_400_000) },
              },
            });
            await transaction.transcriptionUsage.upsert({
              where: { userId_day: { userId: reservation.userId, day } },
              create: { userId: reservation.userId, day },
              update: {},
            });
            const updated = await transaction.transcriptionUsage.updateMany({
              where: {
                userId: reservation.userId,
                day,
                samples: { lte: reservation.dailySamples - reservation.maximumSamples },
              },
              data: { samples: { increment: reservation.maximumSamples } },
            });
            if (updated.count !== 1) {
              return false;
            }
            await transaction.transcriptionCapture.create({
              data: {
                id: reservation.captureId,
                userId: reservation.userId,
                activeUserId: reservation.userId,
                day,
                reservedSamples: reservation.maximumSamples,
                expiresAt: reservation.expiresAt,
              },
            });
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
          continue;
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return false;
        }
        throw error;
      }
    }
    return false;
  }

  return {
    reserveTranscription,
    async claimTranscription(captureId, userId) {
      const claimed = await client.transcriptionCapture.updateMany({
        where: {
          id: captureId,
          userId,
          activeUserId: userId,
          claimed: false,
          expiresAt: { gt: new Date() },
        },
        data: { claimed: true },
      });
      return claimed.count === 1;
    },
    async releaseUnusedTranscription(captureId, userId) {
      await client.$transaction(async (transaction) => {
        const capture = await transaction.transcriptionCapture.findUnique({
          where: { id: captureId },
        });
        if (!capture || capture.userId !== userId || capture.settled || capture.claimed) {
          return;
        }
        const released = await transaction.transcriptionCapture.updateMany({
          where: { id: captureId, userId, claimed: false, settled: false },
          data: { settled: true, activeUserId: null },
        });
        if (released.count === 1) {
          await transaction.transcriptionUsage.update({
            where: { userId_day: { userId, day: capture.day } },
            data: { samples: { decrement: capture.reservedSamples } },
          });
        }
      });
    },
    async settleTranscription(captureId, samples) {
      await client.$transaction(async (transaction) => {
        const capture = await transaction.transcriptionCapture.findUnique({
          where: { id: captureId },
        });
        if (!capture || capture.settled) {
          return;
        }
        const chargedSamples = Math.min(capture.reservedSamples, Math.max(0, Math.ceil(samples)));
        const updated = await transaction.transcriptionCapture.updateMany({
          where: { id: captureId, settled: false },
          data: { settled: true, activeUserId: null },
        });
        if (updated.count === 1) {
          await transaction.transcriptionUsage.update({
            where: { userId_day: { userId: capture.userId, day: capture.day } },
            data: { samples: { decrement: capture.reservedSamples - chargedSamples } },
          });
        }
      });
    },
    close: () => client.$disconnect(),
  };
}
