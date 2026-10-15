import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DesktopStartupStage = {
  CONFIGURATION: 'configuration',
  AUTHENTICATION: 'authentication',
  READINESS: 'readiness',
  SERVICES: 'services',
  WINDOW: 'window',
  RENDERER: 'renderer',
} as const;

export type DesktopStartupStage = (typeof DesktopStartupStage)[keyof typeof DesktopStartupStage];

interface DesktopStartupFailureOptions {
  stage: DesktopStartupStage;
  error: unknown;
  directory: string;
  log: (diagnostic: {
    event: 'desktop.startup.failed';
    stage: DesktopStartupStage;
    code: string;
  }) => void;
  showError: (title: string, message: string) => void;
}

function readStartupErrorCode(error: unknown): string {
  const allowedCodes = new Set([
    'EACCES',
    'EPERM',
    'ENOENT',
    'ENOSPC',
    'ERR_DLOPEN_FAILED',
    'ERR_MODULE_NOT_FOUND',
    'ERR_FAILED',
    'ERR_FILE_NOT_FOUND',
    'ERR_CONNECTION_REFUSED',
  ]);
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    allowedCodes.has(error.code)
  ) {
    return error.code;
  }
  return 'unknown';
}

/** Preserve one bounded, content-free startup failure when no console is visible.
 * Raw errors may contain profile paths, URLs or secrets and are never persisted. */
export async function reportDesktopStartupFailure(
  options: DesktopStartupFailureOptions,
): Promise<void> {
  const diagnostic = {
    event: 'desktop.startup.failed',
    stage: options.stage,
    code: readStartupErrorCode(options.error),
  } as const;
  options.log(diagnostic);
  let saved = false;
  try {
    await mkdir(options.directory, { recursive: true });
    await writeFile(
      join(options.directory, 'DesktopStartup.json'),
      JSON.stringify(diagnostic) + '\n',
      {
        mode: 0o600,
      },
    );
    saved = true;
  } catch {
    /* A read-only profile must not suppress the visible failure report. */
  }
  options.showError(
    'Tro could not open',
    `Startup stage: ${diagnostic.stage}\nError code: ${diagnostic.code}\n\n` +
      (saved
        ? 'A diagnostic was saved in the Tro user-data folder under Logs/DesktopStartup.json.'
        : 'The startup diagnostic could not be saved. Please report the stage and error code above.'),
  );
}
