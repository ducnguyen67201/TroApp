import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { expect, it } from 'vitest';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';

const execute = promisify(execFile);

it('preserves scoped, personal and archived teacher assignments when enabling multiple teachers', async () => {
  const environment = readServerEnv(process.env);
  const schema = `class_teachers_upgrade_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(environment.DATABASE_URL);
  databaseUrl.searchParams.set('schema', schema);
  const directory = await mkdtemp(join(process.cwd(), '.ClassTeachersUpgrade'));
  const migrations = join(directory, 'migrations');
  const newest = '20261014200000_class_teacher_assignments';
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
    const now = new Date();
    await client.user.create({
      data: {
        id: ownerId,
        name: 'Original teacher',
        email: `${ownerId}@example.test`,
        emailVerified: true,
        role: 'teacher',
      },
    });
    await client.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: organizationId, name: 'Existing team', ownerUserId: ownerId, nameSetAt: now },
      });
      await transaction.organizationMembership.create({
        data: { organizationId, userId: ownerId, role: 'teacher' },
      });
    });
    const courseId = randomUUID();
    await client.classroomCourseRevision.create({
      data: { id: courseId, ownerId, title: 'Existing course', content: {} },
    });
    const classIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of classIds.entries()) {
      await client.classroomGroup.create({
        data: {
          id,
          teacherId: ownerId,
          name: `Existing class ${String(index)}`,
          courseRevisionId: courseId,
          organizationId: index === 0 ? organizationId : null,
          deletedAt: index === 2 ? now : null,
        },
      });
    }
    await cp(join('prisma/migrations', newest), join(migrations, newest), { recursive: true });
    await deploy();
    expect(
      await client.classTeacherAssignment.findMany({
        where: { classId: { in: classIds } },
        orderBy: { classId: 'asc' },
      }),
    ).toEqual([...classIds].sort().map((classId) => ({ classId, userId: ownerId })));
    expect(
      await client.classroomGroup.count({ where: { id: { in: classIds }, teacherId: ownerId } }),
    ).toBe(3);
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
