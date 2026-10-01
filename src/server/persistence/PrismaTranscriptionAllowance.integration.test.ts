import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { readServerEnv } from '../Env.js';
import { createPrismaTranscriptionAllowance } from './PrismaTranscriptionAllowance.js';
import { AudioFormat } from '#contracts/Transcription.js';

describe('shared PostgreSQL voice allowance', () => {
  it('admits one stream across clients, rejects replay, and refunds unused samples once', async () => {
    const environment = readServerEnv(process.env);
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
    });
    const first = createPrismaTranscriptionAllowance(environment.DATABASE_URL);
    const second = createPrismaTranscriptionAllowance(environment.DATABASE_URL);
    const userId = randomUUID();
    await client.user.create({
      data: { id: userId, name: 'Synthetic Voice Test', email: `${userId}@example.test` },
    });
    try {
      const reservation = {
        userId,
        expiresAt: new Date(Date.now() + 120_000),
        maximumSamples: 60 * AudioFormat.SAMPLE_RATE,
        dailySamples: 120 * AudioFormat.SAMPLE_RATE,
      };
      const captureIds = [randomUUID(), randomUUID()];
      const accepted = await Promise.all(
        captureIds.map((captureId, index) =>
          (index === 0 ? first : second).reserveTranscription({ ...reservation, captureId }),
        ),
      );
      expect(accepted.filter(Boolean)).toHaveLength(1);
      const acceptedId = captureIds[accepted.findIndex(Boolean)];
      if (!acceptedId) {
        throw new Error('No accepted capture.');
      }
      expect(await first.claimTranscription(acceptedId, userId)).toBe(true);
      expect(await second.claimTranscription(acceptedId, userId)).toBe(false);
      await Promise.all([
        first.settleTranscription(acceptedId, 24000),
        second.settleTranscription(acceptedId, 24000),
      ]);
      const day = new Date(new Date().toISOString().slice(0, 10));
      const usage = await client.transcriptionUsage.findUniqueOrThrow({
        where: { userId_day: { userId, day } },
      });
      expect(usage.samples).toBe(24000);
      const unusedId = randomUUID();
      expect(await first.reserveTranscription({ ...reservation, captureId: unusedId })).toBe(true);
      await first.releaseUnusedTranscription(unusedId, 'foreign-user');
      expect(await first.reserveTranscription({ ...reservation, captureId: randomUUID() })).toBe(
        false,
      );
      await second.releaseUnusedTranscription(unusedId, userId);
      expect(await first.claimTranscription(unusedId, userId)).toBe(false);
      const nextId = randomUUID();
      expect(await second.reserveTranscription({ ...reservation, captureId: nextId })).toBe(true);
      await second.settleTranscription(nextId, reservation.maximumSamples);
      expect(await first.reserveTranscription({ ...reservation, captureId: randomUUID() })).toBe(
        false,
      );
      expect(await first.claimTranscription(acceptedId, userId)).toBe(false);
    } finally {
      await client.user.delete({ where: { id: userId } });
      await first.close();
      await second.close();
      await client.$disconnect();
    }
  });
});
