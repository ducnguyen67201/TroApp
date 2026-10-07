import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { AccountRole } from '#contracts/AccountRole.js';

/** Operator-only adapter. No public HTTP or agent command can assign account roles. */
export function createAccountRoleAdministration(connectionString: string): {
  assignRoleToVerifiedEmail: (email: string, role: AccountRole) => Promise<boolean>;
  close: () => Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return {
    assignRoleToVerifiedEmail: async (email, role) => {
      const result = await client.user.updateMany({
        where: { email: email.trim().toLowerCase(), emailVerified: true },
        data: { role },
      });
      return result.count === 1;
    },
    close: () => client.$disconnect(),
  };
}
