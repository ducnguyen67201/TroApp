import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readDesktopChildEnv } from './Env.js';
import { createDevelopmentProcessGroup } from './DevelopmentProcesses.js';

function waitForDevelopmentChild(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

/** Only local renderer credentials cross into Docker; desktop receives no backend secrets. */
async function startDevelopment(): Promise<void> {
  const shutdown = new AbortController();
  let processes: Awaited<ReturnType<typeof createDevelopmentProcessGroup>> | null = null;
  let closing: Promise<void> | null = null;
  const closeProcesses = async (): Promise<void> => {
    if (processes) {
      closing ??= processes.close();
      await closing;
    }
  };
  const requestShutdown = (): void => {
    shutdown.abort();
    void closeProcesses().catch(() => {
      process.exitCode = 1;
    });
  };

  // Register before cleanup/build I/O so Ctrl-C also stops the startup command trees.
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  try {
    processes = await createDevelopmentProcessGroup(process.cwd());
    shutdown.signal.throwIfAborted();
    const rendererOnly = process.argv.includes('--renderer-only');
    if (!rendererOnly) {
      await processes.stopPrevious();
      shutdown.signal.throwIfAborted();
    }

    await mkdir('.tro-development', { recursive: true });
    const secretPath = '.tro-development/LessonRendererSecret';
    let secret: string;
    try {
      secret = (await readFile(secretPath, 'utf8')).trim();
    } catch {
      secret = randomBytes(32).toString('hex');
      await writeFile(secretPath, secret, { mode: 0o600, flag: 'wx' });
    }
    shutdown.signal.throwIfAborted();
    const desktopEnvironment = readDesktopChildEnv(process.env);
    const apiEnvironment = {
      ...process.env,
      LESSON_RENDER_URL: 'http://127.0.0.1:3010',
      LESSON_RENDER_SECRET: secret,
    };

    try {
      const code = await waitForDevelopmentChild(
        processes.spawn('docker', ['compose', 'up', '-d', '--build', 'lesson-renderer'], {
          ...desktopEnvironment,
          LESSON_RENDER_SECRET: secret,
        }),
      );
      shutdown.signal.throwIfAborted();
      if (code !== 0) {
        throw new Error('Renderer startup failed.');
      }
    } catch (error) {
      shutdown.signal.throwIfAborted();
      if (rendererOnly) {
        throw error;
      }
      console.warn(
        'Renderer startup failed. Check Docker Desktop and build output. Tro can still start; video creation will be unavailable.',
      );
    }
    if (rendererOnly) {
      return;
    }
    shutdown.signal.throwIfAborted();

    // The helper owns each native command's process group, including watchers and Electron.
    const api = processes.spawn('doppler', ['run', '--', 'pnpm', 'dev:api'], apiEnvironment);
    const desktop = processes.spawn('pnpm', ['dev:desktop'], desktopEnvironment);
    const code = await Promise.race([
      waitForDevelopmentChild(api),
      waitForDevelopmentChild(desktop),
    ]);
    if (!shutdown.signal.aborted && code !== 0) {
      process.exitCode = code;
    }
  } catch (error) {
    if (!shutdown.signal.aborted) {
      throw error;
    }
  } finally {
    await closeProcesses();
    process.removeListener('SIGINT', requestShutdown);
    process.removeListener('SIGTERM', requestShutdown);
  }
}

void startDevelopment().catch(() => {
  console.error('Development startup failed. Check local configuration and host prerequisites.');
  process.exitCode = 1;
});
