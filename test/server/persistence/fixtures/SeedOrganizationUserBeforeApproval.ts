import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

interface LegacyOrganizationUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

/** Only the frozen pre-approval fixture uses SQL; current runtime persistence remains Prisma-owned. */
export async function seedOrganizationUserBeforeApproval(
  databaseUrl: string,
  schema: string,
  user: LegacyOrganizationUser,
): Promise<void> {
  if (!/^(organization_upgrade|direct_members_upgrade)_[a-f0-9]{32}$/.test(schema)) {
    throw new Error('Expected a disposable organization upgrade schema');
  }
  const sql = await readFile(
    new URL('./OrganizationUserBeforeApproval.sql', import.meta.url),
    'utf8',
  );
  const client = new Client({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await client.connect();
  try {
    await client.query(sql, [user.id, user.name, user.email, user.emailVerified]);
  } finally {
    await client.end();
  }
}
