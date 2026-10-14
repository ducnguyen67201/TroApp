import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { expect, it } from 'vitest';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { seedOrganizationUserBeforeApproval } from './fixtures/SeedOrganizationUserBeforeApproval.js';
import { readServerEnv } from '../../../src/server/Env.js';

const execute = promisify(execFile);

it('converts current owner invitations to direct additions without restoring revoked or expired invitations', async () => {
  const environment = readServerEnv(process.env);
  const schema = `direct_members_upgrade_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(environment.DATABASE_URL);
  databaseUrl.searchParams.set('schema', schema);
  const directory = await mkdtemp(join(process.cwd(), '.DirectMembersUpgrade'));
  const migrations = join(directory, 'migrations');
  const newest = '20261014190000_direct_organization_members';
  await mkdir(migrations);
  await cp('prisma/schema.prisma', join(directory, 'schema.prisma'));
  await cp('prisma/migrations/migration_lock.toml', join(migrations, 'migration_lock.toml'));
  for (const name of await readdir('prisma/migrations')) {
    if (name !== 'migration_lock.toml' && name < newest) {
      await cp(join('prisma/migrations', name), join(migrations, name), { recursive: true });
    }
  }
  const configuration = join(directory, 'prisma.config.ts');
  await writeFile(
    configuration,
    `import { defineConfig } from 'prisma/config';\nexport default defineConfig({ schema: './schema.prisma', migrations: { path: './migrations' }, datasource: { url: process.env['DATABASE_URL'] } });\n`,
  );
  const deploy = () =>
    execute('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--config', configuration], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
      timeout: 60000,
    });
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl.toString() }, { schema }),
  });
  try {
    await deploy();
    const ownerId = randomUUID();
    const organizationId = randomUUID();
    const personalId = randomUUID();
    const now = new Date();
    for (const id of [ownerId, personalId]) {
      await seedOrganizationUserBeforeApproval(databaseUrl.toString(), schema, {
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
      });
    }
    await client.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: organizationId, name: 'Existing team', ownerUserId: ownerId, nameSetAt: now },
        select: { id: true },
      });
      await transaction.organizationMembership.create({
        data: { organizationId, userId: ownerId, role: 'student' },
      });
    });
    const future = new Date(now.getTime() + 86_400_000);
    await client.organizationInvitation.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId,
          email: 'new@example.test',
          role: 'student',
          codeDigest: 'a'.repeat(64),
          invitedByUserId: ownerId,
          expiresAt: future,
          createdAt: new Date(now.getTime() - 1000),
        },
        {
          id: randomUUID(),
          organizationId,
          email: 'NEW@example.test',
          role: 'teacher',
          codeDigest: 'b'.repeat(64),
          invitedByUserId: ownerId,
          expiresAt: future,
          createdAt: now,
        },
        {
          id: randomUUID(),
          organizationId,
          email: 'revoked@example.test',
          role: 'student',
          codeDigest: 'c'.repeat(64),
          invitedByUserId: ownerId,
          expiresAt: future,
          revokedAt: now,
        },
        {
          id: randomUUID(),
          organizationId,
          email: 'expired@example.test',
          role: 'student',
          codeDigest: 'd'.repeat(64),
          invitedByUserId: ownerId,
          expiresAt: new Date(now.getTime() - 1000),
        },
      ],
    });
    await cp(join('prisma/migrations', newest), join(migrations, newest), { recursive: true });
    await deploy();
    const additions = await client.organizationEmailMember.findMany({ where: { organizationId } });
    expect(additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({ email: 'new@example.test', role: 'teacher' });
    expect(
      await client.organizationInvitation.count({
        where: { organizationId, acceptedAt: null, revokedAt: null },
      }),
    ).toBe(0);
    expect(await client.user.findUniqueOrThrow({ where: { id: ownerId } })).toMatchObject({
      hasChosenOrganization: true,
      canCreateOrganization: false,
    });
    expect(await client.user.findUniqueOrThrow({ where: { id: personalId } })).toMatchObject({
      hasChosenOrganization: false,
      canCreateOrganization: false,
    });
    expect(
      (await client.organization.findUniqueOrThrow({ where: { id: organizationId } })).name,
    ).toBe('Existing team');
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
