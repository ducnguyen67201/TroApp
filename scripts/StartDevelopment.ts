import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readDesktopChildEnv } from './Env.js';

async function run(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: environment });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${String(code)}.`));
      }
    });
  });
}

/** Only local renderer credentials cross into Docker; desktop receives no backend secrets. */
async function startDevelopment(): Promise<void> {
  await mkdir('.tro-development', { recursive: true });
  const secretPath = '.tro-development/LessonRendererSecret';
  let secret: string;
  try {
    secret = (await readFile(secretPath, 'utf8')).trim();
  } catch {
    secret = randomBytes(32).toString('hex');
    await writeFile(secretPath, secret, { mode: 0o600, flag: 'wx' });
  }
  const desktopEnvironment = readDesktopChildEnv(process.env);
  const apiEnvironment = {
    ...process.env,
    LESSON_RENDER_URL: 'http://127.0.0.1:3010',
    LESSON_RENDER_SECRET: secret,
  };
  try {
    await run('docker', ['compose', 'up', '-d', '--build', 'lesson-renderer'], {
      ...desktopEnvironment,
      LESSON_RENDER_SECRET: secret,
    });
  } catch {
    if (process.argv.includes('--renderer-only')) {
      throw new Error('Renderer startup failed.');
    }
    console.warn(
      'Renderer startup failed. Check Docker Desktop and build output. Tro can still start; video creation will be unavailable.',
    );
  }
  if (process.argv.includes('--renderer-only')) {
    return;
  }
  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const child of children) {
      child.kill('SIGTERM');
    }
  };
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, stop);
  }
  // Doppler injects server keys only into the API child, also supporting plain pnpm dev.
  children.push(
    spawn('doppler', ['run', '--', 'pnpm', 'dev:api'], { stdio: 'inherit', env: apiEnvironment }),
  );
  children.push(spawn('pnpm', ['dev:desktop'], { stdio: 'inherit', env: desktopEnvironment }));
  for (const child of children) {
    child.once('error', () => {
      process.exitCode = 1;
      stop();
    });
    child.once('exit', (code) => {
      if (!stopping && code) {
        process.exitCode = code;
      }
      stop();
    });
  }
}

void startDevelopment().catch(() => {
  console.error('Development startup failed. Check local configuration and host prerequisites.');
  process.exitCode = 1;
});
