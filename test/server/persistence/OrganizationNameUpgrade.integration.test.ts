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

it('preserves and permanently locks populated organization names during upgrade', async () => {
  const environment = readServerEnv(process.env);
  const schema = `organization_upgrade_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(environment.DATABASE_URL);
  databaseUrl.searchParams.set('schema', schema);
  const directory = await mkdtemp(join(process.cwd(), '.OrganizationNameUpgrade'));
  const migrations = join(directory, 'migrations');
  const newest = '20261014160000_organization_name_setup';
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
    await seedOrganizationUserBeforeApproval(databaseUrl.toString(), schema, {
      id: ownerId,
      name: 'Owner',
      email: `${ownerId}@example.test`,
      emailVerified: true,
    });
    const legacy = await client.$transaction(async (transaction) => {
      /* Explicit old-column selection lets the current client seed the pre-upgrade schema. */
      const organization = await transaction.organization.create({
        data: { id: organizationId, name: 'Existing school', ownerUserId: ownerId },
        select: { id: true, name: true, createdAt: true },
      });
      await transaction.organizationMembership.create({
        data: { organizationId, userId: ownerId, role: 'student' },
      });
      return organization;
    });
    for (const name of await readdir('prisma/migrations')) {
      if (name !== 'migration_lock.toml' && name >= newest) {
        await cp(join('prisma/migrations', name), join(migrations, name), { recursive: true });
      }
    }
    await deploy();
    const saved = await client.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(saved.name).toBe(legacy.name);
    expect(saved.nameSetAt).toEqual(legacy.createdAt);
    await expect(
      client.organization.update({
        where: { id: organizationId },
        data: { name: 'Changed legacy name' },
      }),
    ).rejects.toThrow();
    expect(
      await client.organizationMembership.count({ where: { organizationId, userId: ownerId } }),
    ).toBe(1);
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
