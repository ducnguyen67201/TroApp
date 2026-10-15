import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopStartupStage,
  reportDesktopStartupFailure,
} from '../../../src/desktop/main/DesktopStartupFailure.js';

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'TroStartup-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('startup failure reporting without a console', () => {
  it('saves a bounded diagnostic and shows the failure without exposing raw error data', async () => {
    const directory = join(await createDirectory(), 'Logs');
    const log = vi.fn<Parameters<typeof reportDesktopStartupFailure>[0]['log']>();
    const showError = vi.fn<(title: string, message: string) => void>();
    await reportDesktopStartupFailure({
      stage: DesktopStartupStage.SERVICES,
      error: Object.assign(new Error('secret URL and profile'), { code: 'ERR_DLOPEN_FAILED' }),
      directory,
      log,
      showError,
    });
    const diagnostic = {
      event: 'desktop.startup.failed',
      stage: 'services',
      code: 'ERR_DLOPEN_FAILED',
    };
    expect(log).toHaveBeenCalledWith(diagnostic);
    expect(await readFile(join(directory, 'DesktopStartup.json'), 'utf8')).toBe(
      JSON.stringify(diagnostic) + '\n',
    );
    expect(showError).toHaveBeenCalledWith(
      'Tro could not open',
      expect.stringContaining('Logs/DesktopStartup.json'),
    );
    expect(JSON.stringify(showError.mock.calls)).not.toContain('secret');
  });

  it('still reports the stage when the profile cannot be written and redacts unknown codes', async () => {
    const directory = join(await createDirectory(), 'NotADirectory');
    await writeFile(directory, 'fixture');
    const showError = vi.fn<(title: string, message: string) => void>();
    const log = vi.fn<Parameters<typeof reportDesktopStartupFailure>[0]['log']>();
    await reportDesktopStartupFailure({
      stage: DesktopStartupStage.CONFIGURATION,
      error: Object.assign(new Error('private configuration'), { code: 'secret-code' }),
      directory,
      log,
      showError,
    });
    expect(log).toHaveBeenCalledWith({
      event: 'desktop.startup.failed',
      stage: 'configuration',
      code: 'unknown',
    });
    expect(showError).toHaveBeenCalledWith(
      'Tro could not open',
      expect.stringContaining('could not be saved'),
    );
    expect(JSON.stringify(showError.mock.calls)).not.toContain('secret');
  });
});
