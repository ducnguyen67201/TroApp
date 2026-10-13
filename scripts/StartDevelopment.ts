import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readDesktopChildEnv } from './Env.js';
import { createDevelopmentProcessGroup } from './DevelopmentProcesses.js';

const DevelopmentStartupStage = {
  WORKSPACE: 'workspace',
  CLEANUP: 'previous-process-cleanup',
  CREDENTIAL: 'renderer-credential',
  ENVIRONMENT: 'desktop-environment',
  RENDERER: 'renderer-startup',
  API: 'api-startup',
  DESKTOP: 'desktop-startup',
  SERVICES: 'native-services',
} as const;

let startupStage: (typeof DevelopmentStartupStage)[keyof typeof DevelopmentStartupStage] =
  DevelopmentStartupStage.WORKSPACE;

/** Report only owned messages or allowlisted OS codes; errors can contain secret-bearing arguments. */
function readStartupFailureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Unexpected startup failure.';
  }
  const messages = new Set([
    'Development process metadata is unavailable.',
    'The development launcher could not identify itself.',
    'A previous development process could not be stopped.',
    'Previous development processes are still running. Close their terminal and retry.',
    'Development startup has already stopped.',
    'Desktop host environment is invalid.',
    'Renderer startup failed.',
  ]);
  if (messages.has(error.message)) {
    return error.message;
  }
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(error.code)
  ) {
    return `Host operation failed (${error.code}).`;
  }
  return error.name === 'ZodError'
    ? 'Running process metadata is invalid.'
    : 'Unexpected startup failure.';
}

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
      startupStage = DevelopmentStartupStage.CLEANUP;
      await processes.stopPrevious();
      shutdown.signal.throwIfAborted();
    }

    startupStage = DevelopmentStartupStage.CREDENTIAL;
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
    startupStage = DevelopmentStartupStage.ENVIRONMENT;
    const desktopEnvironment = readDesktopChildEnv(process.env);
    const apiEnvironment = {
      ...process.env,
      LESSON_RENDER_URL: 'http://127.0.0.1:3010',
      LESSON_RENDER_SECRET: secret,
    };

    try {
      startupStage = DevelopmentStartupStage.RENDERER;
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
    startupStage = DevelopmentStartupStage.API;
    const api = processes.spawn('doppler', ['run', '--', 'pnpm', 'dev:api'], apiEnvironment);
    startupStage = DevelopmentStartupStage.DESKTOP;
    const desktop = processes.spawn('pnpm', ['dev:desktop'], desktopEnvironment);
    startupStage = DevelopmentStartupStage.SERVICES;
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

void startDevelopment().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'development.startup.failed',
      stage: startupStage,
      reason: readStartupFailureReason(error),
    }),
  );
  console.error('Development startup failed. Check local configuration and host prerequisites.');
  process.exitCode = 1;
});
