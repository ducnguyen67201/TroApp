import { createHmac, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { AuthUserSchema } from '#contracts/AuthSession.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createAuthDatabase } from '../../../src/server/persistence/AuthDatabase.js';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';

describe('administrator account permissions', () => {
  it('defaults administrator access off and exposes database changes without allowing self-promotion', async () => {
    const environment = readServerEnv(process.env);
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
    });
    const authentication = createAuthDatabase(environment);
    const userId = randomUUID();
    const token = randomUUID();
    const sessionSchema = z.looseObject({
      user: AuthUserSchema.extend({ role: z.enum(AccountRole) }).loose(),
    });

    try {
      const user = await client.user.create({
        data: {
          id: userId,
          name: 'Administrator fixture',
          email: `${userId}@example.test`,
          emailVerified: true,
        },
      });
      expect(user.isAdmin).toBe(false);
      expect(user.role).toBe(AccountRole.STUDENT);
      await client.session.create({
        data: {
          id: randomUUID(),
          userId,
          token,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const signature = createHmac('sha256', environment.AUTH_SECRET)
        .update(token)
        .digest('base64');
      const authContext = await authentication.auth.$context;
      const cookie = `${authContext.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
      const readSession = async () => {
        const response = await authentication.auth.handler(
          new Request(`${environment.AUTH_BASE_URL}/api/auth/get-session`, {
            headers: { cookie },
          }),
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        return sessionSchema.parse(body);
      };

      expect((await readSession()).user.isAdmin).toBe(false);
      const selfPromotion = await authentication.auth.handler(
        new Request(`${environment.AUTH_BASE_URL}/api/auth/update-user`, {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            origin: environment.AUTH_BASE_URL,
          },
          body: JSON.stringify({ isAdmin: true }),
        }),
      );
      expect(selfPromotion.status).toBe(400);
      expect((await client.user.findUniqueOrThrow({ where: { id: userId } })).isAdmin).toBe(false);

      await client.user.update({ where: { id: userId }, data: { isAdmin: true } });
      const administrator = await readSession();
      expect(administrator.user.isAdmin).toBe(true);
      expect(administrator.user.role).toBe(AccountRole.STUDENT);

      await client.user.update({ where: { id: userId }, data: { isAdmin: false } });
      expect((await readSession()).user.isAdmin).toBe(false);
    } finally {
      await client.user.deleteMany({ where: { id: userId } });
      await authentication.close();
      await client.$disconnect();
    }
  });
});
