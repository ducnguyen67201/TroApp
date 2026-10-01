import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';

const executeFile = promisify(execFile);
const containerName = `tro-integration-${randomUUID()}`;
const packageCli = z.string().min(1).parse(process.env['npm_execpath']);
const integrationState = { didStartContainer: false };

/** Isolated database: no volumes and no connection to a supplied/cloud DATABASE_URL. */
async function runIntegration(): Promise<void> {
  await executeFile('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_USER=tro',
    '--env',
    'POSTGRES_PASSWORD=synthetic_test_only',
    '--env',
    'POSTGRES_DB=tro_test',
    'postgres:17-alpine',
  ]);
  integrationState.didStartContainer = true;

  let isReady = false;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await executeFile('docker', [
        'exec',
        containerName,
        'pg_isready',
        '-U',
        'tro',
        '-d',
        'tro_test',
      ]);
      isReady = true;
      break;
    } catch {
      await setTimeout(500);
    }
  }

  if (!isReady) {
    throw new Error('The disposable PostgreSQL container did not become ready.');
  }

  const publishedPort = await executeFile('docker', ['port', containerName, '5432/tcp']);
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(publishedPort.stdout.trim().split(':').at(-1));
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    APP_ENV: 'stage',
    AUTH_SECRET: 'synthetic-integration-secret-only-000000000000',
    AUTH_BASE_URL: 'https://api.example.test',
    DATABASE_URL: `postgresql://tro:synthetic_test_only@127.0.0.1:${String(port)}/tro_test`,
  };

  await executeFile(process.execPath, [packageCli, 'exec', 'prisma', 'migrate', 'deploy'], {
    env: environment,
  });
  const result = await executeFile(
    process.execPath,
    [packageCli, 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts'],
    { env: environment },
  );
  console.info(result.stdout);
}

try {
  await runIntegration();
} catch (error: unknown) {
  console.error('Integration checks failed.');
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
} finally {
  if (integrationState.didStartContainer) {
    await executeFile('docker', ['rm', '--force', containerName]).catch(() => {
      console.error('Could not remove the disposable integration container.');
      process.exitCode = 1;
    });
  }
}
