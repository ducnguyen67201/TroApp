import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { VoiceoverAllowance } from '../features/voiceover/VoiceoverPorts.js';
import { VoiceoverLimits } from '#contracts/Voiceover.js';

export interface VoiceoverBudget {
  dailyCharacters: number;
  globalDailyCharacters: number;
  globalStreams: number;
}

/** Serializable admission survives multiple API instances and ambiguous paid failures. */
export function createPrismaVoiceoverAllowance(
  databaseUrl: string,
  budget: VoiceoverBudget,
): VoiceoverAllowance & { close(): Promise<void> } {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  return {
    async reserveVoiceover(userId, utteranceId, characters) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await client.$transaction(
            async (transaction) => {
              const now = new Date();
              const day = new Date(now.toISOString().slice(0, 10));
              await transaction.voiceoverUtterance.updateMany({
                where: { expiresAt: { lte: now }, activeUserId: { not: null } },
                data: { activeUserId: null },
              });
              if (
                (await transaction.voiceoverUtterance.count({
                  where: { activeUserId: { not: null } },
                })) >= budget.globalStreams
              ) {
                return false;
              }
              await transaction.voiceoverUsage.upsert({
                where: { userId_day: { userId, day } },
                create: { userId, day },
                update: {},
              });
              await transaction.voiceoverDailyBudget.upsert({
                where: { day },
                create: { day },
                update: {},
              });
              const usage = await transaction.voiceoverUsage.findUniqueOrThrow({
                where: { userId_day: { userId, day } },
              });
              const global = await transaction.voiceoverDailyBudget.findUniqueOrThrow({
                where: { day },
              });
              if (
                usage.characters + characters > budget.dailyCharacters ||
                global.characters + characters > budget.globalDailyCharacters
              ) {
                return false;
              }
              await transaction.voiceoverUtterance.create({
                data: {
                  id: utteranceId,
                  userId,
                  activeUserId: userId,
                  characters,
                  expiresAt: new Date(now.getTime() + VoiceoverLimits.MAX_DURATION_MS + 5000),
                },
              });
              await transaction.voiceoverUsage.update({
                where: { userId_day: { userId, day } },
                data: { characters: { increment: characters } },
              });
              await transaction.voiceoverDailyBudget.update({
                where: { day },
                data: { characters: { increment: characters } },
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
    },
    async finishVoiceover(userId, utteranceId) {
      await client.voiceoverUtterance.updateMany({
        where: { id: utteranceId, userId },
        data: { activeUserId: null },
      });
    },
    close: () => client.$disconnect(),
  };
}
