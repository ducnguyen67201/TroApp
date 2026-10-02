import { PrismaPg } from '@prisma/adapter-pg';
import { betterAuth } from 'better-auth';
import { electron } from '@better-auth/electron';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
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
    /* The desktop's supported sign-in flow uses Google. */
    emailAndPassword: { enabled: false },
    disabledPaths: ['/sign-up/email', '/sign-in/email'],
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
    readSignedInUserId: async (headers: IncomingHttpHeaders): Promise<string | null> => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
      return session?.user.id ?? null;
    },
    close: () => client.$disconnect(),
  };
}
