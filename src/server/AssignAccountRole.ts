import { z } from 'zod';
import { AccountRoleSchema } from '#contracts/AccountRole.js';
import { readServerEnv } from './Env.js';
import { createAccountRoleAdministration } from './persistence/AccountRoles.js';

/** Explicit backend operator command; account IDs and environment allowlists are unnecessary. */
async function assignAccountRole(): Promise<void> {
  const input = z.tuple([z.email(), AccountRoleSchema]).safeParse(process.argv.slice(2));
  if (!input.success) {
    throw new Error('Usage: pnpm account:role <verified-email> <student|teacher>');
  }
  const environment = readServerEnv(process.env);
  const administration = createAccountRoleAdministration(environment.DATABASE_URL);
  try {
    if (!(await administration.assignRoleToVerifiedEmail(input.data[0], input.data[1]))) {
      throw new Error('No verified account matched. Sign in with Google first.');
    }
    console.info('Account role saved. Open Classroom to refresh your role.');
  } finally {
    await administration.close();
  }
}

void assignAccountRole().catch((error: unknown) => {
  const safeMessages = new Set([
    'Usage: pnpm account:role <verified-email> <student|teacher>',
    'No verified account matched. Sign in with Google first.',
  ]);
  console.error(
    error instanceof Error && safeMessages.has(error.message)
      ? error.message
      : 'Could not save the account role. Check backend access.',
  );
  process.exitCode = 1;
});
