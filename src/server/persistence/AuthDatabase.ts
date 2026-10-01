import { PrismaPg } from '@prisma/adapter-pg';
import { betterAuth } from 'better-auth';
import { electron } from '@better-auth/electron';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaClient } from '../generated/prisma/client.js';
import type { ServerEnv } from '../Env.js';

/** Keeps accounts and sessions on the backend; no provider secret enters Electron. */
export function createAuthDatabase(environment: ServerEnv) {
  const adapter = new PrismaPg({ connectionString: environment.DATABASE_URL });
  const client = new PrismaClient({ adapter });
  const auth = betterAuth({
    database: prismaAdapter(client, { provider: 'postgresql' }),
    secret: environment.AUTH_SECRET,
    baseURL: environment.AUTH_BASE_URL,
    emailAndPassword: { enabled: true },
    socialProviders:
      environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: environment.GOOGLE_CLIENT_ID,
              clientSecret: environment.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},
    plugins: [electron()],
    trustedOrigins: [environment.AUTH_BASE_URL, 'app.tro.desktop:/'],
  });

  return {
    auth,
    countModelRequest: async (userId: string, day: Date): Promise<number> => {
      const usage = await client.modelUsage.upsert({
        where: { userId_day: { userId, day } },
        create: { userId, day, requestCount: 1 },
        update: { requestCount: { increment: 1 } },
        select: { requestCount: true },
      });
      return usage.requestCount;
    },
    close: () => client.$disconnect(),
  };
}
