import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';

const execute = promisify(execFile);

it('deploys the additive insight migration onto populated prior migrations without losing legacy work', async () => {
  const environment = readServerEnv(process.env);
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(environment.DATABASE_URL);
  databaseUrl.searchParams.set('schema', schema);
  const directory = await mkdtemp(join(process.cwd(), '.ClassroomUpgrade'));
  const migrations = join(directory, 'migrations');
  await mkdir(migrations);
  await cp('prisma/schema.prisma', join(directory, 'schema.prisma'));
  await cp('prisma/migrations/migration_lock.toml', join(migrations, 'migration_lock.toml'));
  const newest = '20261008190000_classroom_insights';
  for (const name of await readdir('prisma/migrations')) {
    if (name !== 'migration_lock.toml' && name !== newest) {
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
    const teacherId = randomUUID(),
      studentId = randomUUID();
    await client.user.createMany({
      data: [teacherId, studentId].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        role: id === teacherId ? 'teacher' : 'student',
      })),
    });
    const content = createCourseContent();
    const activityId = content.modules[0]?.lessons[0]?.activities[0]?.id;
    if (!activityId) {
      throw new Error('Missing fixture activity.');
    }
    const course = await client.classroomCourseRevision.create({
      data: { id: randomUUID(), ownerId: teacherId, title: 'Legacy', content },
    });
    const group = await client.classroomGroup.create({
      data: { id: randomUUID(), teacherId, name: 'Legacy', courseRevisionId: course.id },
    });
    const meeting = await client.classroomMeeting.create({
      data: {
        id: randomUUID(),
        classId: group.id,
        status: 'live',
        phase: 'practice',
        pacing: 'teacher',
        currentActivityId: activityId,
      },
    });
    const participation = await client.classroomParticipation.create({
      data: {
        id: randomUUID(),
        classSessionId: meeting.id,
        studentId,
        deviceId: randomUUID(),
        leaseUntil: new Date('2026-10-09'),
      },
    });
    const attempt = await client.classroomAttempt.create({
      data: { id: randomUUID(), participationId: participation.id, activityId, evidence: [] },
      select: { id: true },
    });
    const receipt = await client.classroomSubmission.create({
      data: {
        id: randomUUID(),
        attemptId: attempt.id,
        idempotencyKey: randomUUID(),
        url: 'https://scratch.mit.edu/projects/123/',
        submittedAt: new Date('2026-10-08'),
      },
    });
    const snapshot = await client.classroomWorkSnapshot.create({
      data: {
        id: randomUUID(),
        studentId,
        attemptId: attempt.id,
        courseRevisionId: course.id,
        checkpointId: randomUUID(),
        rubricRevisionId: randomUUID(),
        manifestDigest: 'a'.repeat(64),
        createdAt: new Date('2026-10-08'),
      },
      select: { id: true },
    });
    await cp(join('prisma/migrations', newest), join(migrations, newest), { recursive: true });
    await deploy();
    expect(
      (await client.classroomSubmission.findUniqueOrThrow({ where: { id: receipt.id } })).url,
    ).toBe(receipt.url);
    expect(
      (await client.classroomWorkSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } }))
        .expiredAt,
    ).toBeNull();
    expect(
      (await client.classroomAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).lastSavedAt,
    ).toBeNull();
    expect(await client.classroomLearningEvent.count()).toBe(0);
    const state = await client.classroomInsightState.create({ data: { classId: group.id } });
    expect(state.revision).toBe(0n);
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
