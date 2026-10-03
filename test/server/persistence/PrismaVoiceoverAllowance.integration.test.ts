import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { expect, it } from 'vitest';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaVoiceoverAllowance } from '../../../src/server/persistence/PrismaVoiceoverAllowance.js';

it('admits one speech stream across clients and retains charges/replay protection after cancellation', async () => {
  const environment = readServerEnv(process.env);
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  const budget = { dailyCharacters: 12, globalDailyCharacters: 1000000, globalStreams: 20 };
  const first = createPrismaVoiceoverAllowance(environment.DATABASE_URL, budget);
  const second = createPrismaVoiceoverAllowance(environment.DATABASE_URL, budget);
  const userId = randomUUID();
  await client.user.create({
    data: { id: userId, name: 'Speech Test', email: `${userId}@example.test` },
  });
  try {
    const ids = [randomUUID(), randomUUID()];
    const accepted = await Promise.all(
      ids.map((id, index) => (index === 0 ? first : second).reserveVoiceover(userId, id, 6)),
    );
    expect(accepted.filter(Boolean)).toHaveLength(1);
    const id = ids[accepted.findIndex(Boolean)];
    if (!id) {
      throw new Error('No speech admitted.');
    }
    await first.finishVoiceover(userId, id);
    expect(await second.reserveVoiceover(userId, id, 6)).toBe(false);
    const next = randomUUID();
    expect(await second.reserveVoiceover(userId, next, 6)).toBe(true);
    await second.finishVoiceover(userId, next);
    expect(await first.reserveVoiceover(userId, randomUUID(), 1)).toBe(false);
  } finally {
    await client.user.delete({ where: { id: userId } });
    await first.close();
    await second.close();
    await client.$disconnect();
  }
});
