import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  notarizeMacDmg,
  selectMacArtifacts,
  verifyMacRelease,
} from '../../scripts/VerifyMacRelease.js';
import type { MacCommand } from '../../scripts/MacSigning.js';
import {
  createMacFixture,
  macCommand,
  macProfileSettings,
  macSettings,
} from './MacReleaseFixtures.js';

const submissionId = '52890475-5477-40f8-8a06-107611206472';
const temporary: string[] = [];
const artifactNames = ['Tro-0.1.1-macos-arm64.dmg', 'Tro-0.1.1-macos-arm64.zip'];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRelease(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tro-mac-release-test-'));
  temporary.push(directory);
  for (const name of artifactNames) {
    await writeFile(join(directory, name), `artifact ${name}`);
  }
  return directory;
}

const archiveCommand: MacCommand = async (executable, args) => {
  if (executable.endsWith('ditto')) {
    await createMacFixture(join(z.string().parse(args.at(-1)), 'Tro.app'));
  }
  if (executable.endsWith('hdiutil') && args[0] === 'attach') {
    await createMacFixture(join(z.string().parse(args.at(-1)), 'Tro.app'));
  }
  return macCommand(executable, args);
};

const acceptedNotaryCommand: MacCommand = (executable, args) => {
  if (args[0] === 'notarytool') {
    return Promise.resolve({
      stdout: JSON.stringify({ id: submissionId, status: 'Accepted' }),
      stderr: '',
    });
  }
  return archiveCommand(executable, args);
};

describe('Mac notarization', () => {
  it('submits once and staples only the accepted submission', async () => {
    let polls = 0;
    const run = vi.fn<MacCommand>((exe, args) => {
      if (args.includes('submit')) {
        return Promise.resolve({ stdout: JSON.stringify({ id: submissionId }), stderr: '' });
      }
      if (args.includes('info')) {
        polls += 1;
        return Promise.resolve({
          stdout: JSON.stringify({
            id: submissionId,
            status: polls === 1 ? 'In Progress' : 'Accepted',
          }),
          stderr: '',
        });
      }
      return macCommand(exe, args);
    });
    const wait = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
    expect(await notarizeMacDmg('/fixture.dmg', macSettings, { run, wait, now: () => 0 })).toBe(
      submissionId,
    );
    expect(run.mock.calls.filter(([, args]) => args.includes('submit'))).toHaveLength(1);
    expect(run.mock.calls.filter(([, args]) => args.includes('info'))).toHaveLength(2);
    expect(run).toHaveBeenCalledWith('/usr/bin/xcrun', [
      'notarytool',
      'submit',
      '/fixture.dmg',
      '--key',
      macSettings.apiKey,
      '--key-id',
      macSettings.apiKeyId,
      '--issuer',
      macSettings.apiIssuer,
      '--output-format',
      'json',
    ]);
    expect(wait).toHaveBeenCalledWith(15_000);
    expect(run.mock.calls.filter(([, args]) => args[0] === 'stapler')).toEqual([
      ['/usr/bin/xcrun', ['stapler', 'staple', '/fixture.dmg']],
      ['/usr/bin/xcrun', ['stapler', 'validate', '/fixture.dmg']],
    ]);
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['stapler', 'validate', '/fixture.dmg']);
  });

  it.each(['Accepted', 'Invalid'] as const)(
    'uses only the temporary keychain profile through a %s submission',
    async (status) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const run = vi.fn<MacCommand>((exe, args) => {
          if (args[0] === 'notarytool') {
            return Promise.resolve({
              stdout: JSON.stringify(
                args.includes('log') ? { issues: [] } : { id: submissionId, status },
              ),
              stderr: '',
            });
          }
          return macCommand(exe, args);
        });
        const result = notarizeMacDmg('/fixture.dmg', macProfileSettings, {
          run,
          wait: () => Promise.resolve(),
          now: () => 0,
        });
        if (status === 'Accepted') {
          await expect(result).resolves.toBe(submissionId);
        } else {
          await expect(result).rejects.toThrow('Apple rejected');
        }
        const notaryCalls = run.mock.calls
          .map(([, args]) => args)
          .filter((args) => args[0] === 'notarytool');
        const auth = [
          '--keychain-profile',
          macProfileSettings.keychainProfile,
          '--keychain',
          macProfileSettings.keychain,
        ];
        expect(notaryCalls).toEqual([
          ['notarytool', 'submit', '/fixture.dmg', ...auth, '--output-format', 'json'],
          ['notarytool', 'info', submissionId, ...auth, '--output-format', 'json'],
          ...(status === 'Invalid' ? [['notarytool', 'log', submissionId, ...auth]] : []),
        ]);
        const arguments_ = notaryCalls.flat();
        for (const secretArgument of [
          '--password',
          '--apple-id',
          '--key',
          '--key-id',
          '--issuer',
        ]) {
          expect(arguments_).not.toContain(secretArgument);
        }
      } finally {
        error.mockRestore();
      }
    },
  );

  it('rejects Apple failures and logs only a safe issue count', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = vi.fn<MacCommand>((_exe, args) =>
        Promise.resolve({
          stdout: JSON.stringify(
            args.includes('log')
              ? { issues: [{ message: 'SECRET DETAILS' }] }
              : { id: submissionId, status: 'Invalid' },
          ),
          stderr: '',
        }),
      );
      await expect(
        notarizeMacDmg('/fixture.dmg', macSettings, {
          run,
          wait: () => Promise.resolve(),
          now: () => 0,
        }),
      ).rejects.toThrow('Apple rejected');
      expect(JSON.stringify(error.mock.calls)).not.toContain('SECRET DETAILS');
      expect(JSON.stringify(error.mock.calls)).toContain('issueCount');
      expect(run.mock.calls.some(([, args]) => args.includes('staple'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    'not json',
    '{}',
    JSON.stringify({ id: submissionId, status: 'Unexpected' }),
    JSON.stringify({ id: '977794f0-b8d4-4cb9-94ea-1ef7eb299b88', status: 'Accepted' }),
  ])('rejects malformed or unrelated Apple results', async (response) => {
    const run: MacCommand = (_exe, args) =>
      Promise.resolve({
        stdout: args.includes('submit') ? JSON.stringify({ id: submissionId }) : response,
        stderr: '',
      });
    await expect(
      notarizeMacDmg('/fixture.dmg', macSettings, {
        run,
        wait: () => Promise.resolve(),
        now: () => 0,
      }),
    ).rejects.toThrow();
  });

  it('bounds pending submissions and never resubmits on timeout', async () => {
    let time = 0;
    const run = vi.fn<MacCommand>(() =>
      Promise.resolve({
        stdout: JSON.stringify({ id: submissionId, status: 'In Progress' }),
        stderr: '',
      }),
    );
    await expect(
      notarizeMacDmg('/fixture.dmg', macSettings, {
        run,
        now: () => time,
        wait: () => {
          time += 30 * 60 * 1000;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('deadline');
    expect(run.mock.calls.filter(([, args]) => args.includes('submit'))).toHaveLength(1);
  });
});

describe('Mac distribution verification', () => {
  it('reports CLI argument errors without printing their private values', async () => {
    const result = await new Promise<{
      exitCode: number | string | null | undefined;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../../scripts/VerifyMacRelease.ts', import.meta.url)),
          '--private-argument',
          'private-value-never-log',
        ],
        { encoding: 'utf8', timeout: 10_000 },
        (error, stdout, stderr) => {
          resolve({ exitCode: error?.code, stdout, stderr });
        },
      );
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"stage":"read-settings"');
    expect(result.stderr).toContain('"code":"ERR_PARSE_ARGS_UNKNOWN_OPTION"');
    expect(result.stderr).not.toContain('private-argument');
    expect(result.stderr).not.toContain('private-value-never-log');
  });

  it('reports artifact selection counts without leaking arbitrary filenames', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() =>
        selectMacArtifacts(
          [...artifactNames, 'private-filename.yml', 'builder-debug.yml'],
          '0.1.1',
          'arm64',
        ),
      ).toThrow('artifacts');
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          event: 'mac.release.artifacts.rejected',
          architecture: 'arm64',
          expectedDmgPresent: true,
          expectedZipPresent: true,
          dmgCount: 1,
          zipCount: 1,
          metadataCount: 2,
          hasBuilderDebug: true,
          hasBuilderConfig: false,
        }),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('selects exact version/architecture and rejects stale files or unknown feed metadata', () => {
    expect(selectMacArtifacts(artifactNames, '0.1.1', 'arm64')).toEqual({
      dmg: artifactNames[0],
      zip: artifactNames[1],
    });
    for (const names of [
      [],
      artifactNames.slice(0, 1),
      [...artifactNames, 'old.dmg'],
      [...artifactNames, 'unknown-mac.yml'],
    ]) {
      expect(() => selectMacArtifacts(names, '0.1.1', 'arm64')).toThrow('artifacts');
    }
    expect(() => selectMacArtifacts(artifactNames, '../escape', 'arm64')).toThrow();
    expect(() => selectMacArtifacts(artifactNames, '0.1.1', 'x64')).toThrow();
  });

  it.each(['arm64', 'x64'] as const)(
    'selects only the %s distributables from realistic builder output',
    (architecture) => {
      const dmg = `Tro-0.1.1-macos-${architecture}.dmg`;
      const zip = `Tro-0.1.1-macos-${architecture}.zip`;
      expect(
        selectMacArtifacts(
          [
            dmg,
            zip,
            `${dmg}.blockmap`,
            `${zip}.blockmap`,
            'builder-debug.yml',
            'builder-effective-config.yaml',
            'latest-mac.yml',
          ],
          '0.1.1',
          architecture,
        ),
      ).toEqual({ dmg, zip });
    },
  );

  it.each([
    'beta-mac.yml',
    'unknown.yaml',
    'Builder-debug.yml',
    'builder-debug.yaml',
    'builder-effective-config.yml',
    'builder-effective-config.YAML',
  ])('rejects %s even alongside known builder diagnostics', (metadata) => {
    expect(() =>
      selectMacArtifacts(
        [...artifactNames, 'builder-debug.yml', 'builder-effective-config.yaml', metadata],
        '0.1.1',
        'arm64',
      ),
    ).toThrow('artifacts');
  });

  it('does not let builder diagnostics mask missing, stale or wrong-architecture archives', () => {
    const diagnostics = ['builder-debug.yml', 'builder-effective-config.yaml'];
    for (const names of [
      diagnostics,
      [...artifactNames.slice(0, 1), ...diagnostics],
      [...artifactNames, ...diagnostics, 'old.zip'],
    ]) {
      expect(() => selectMacArtifacts(names, '0.1.1', 'arm64')).toThrow('artifacts');
    }
    expect(() => selectMacArtifacts([...artifactNames, ...diagnostics], '0.1.1', 'x64')).toThrow(
      'artifacts',
    );
    expect(() => selectMacArtifacts([...artifactNames, ...diagnostics], '0.1.2', 'arm64')).toThrow(
      'artifacts',
    );
  });

  it('verifies extracted app and mounted app, then hashes final stapled bytes', async () => {
    const directory = await createRelease();
    await writeFile(join(directory, 'latest-mac.yml'), 'stale builder hashes before stapling');
    const run = vi.fn<MacCommand>(archiveCommand);
    await verifyMacRelease(directory, macSettings, '0.1.1', run, async (path) => {
      await writeFile(path, 'stapled-final-dmg');
      return submissionId;
    });
    const raw: unknown = JSON.parse(
      await readFile(join(directory, 'MacSignatures-arm64.json'), 'utf8'),
    );
    const inventory = z
      .object({
        status: z.literal('verified'),
        artifacts: z.array(z.object({ name: z.string(), size: z.number(), sha256: z.string() })),
        files: z.array(z.object({ path: z.string() })),
      })
      .parse(raw);
    expect(inventory.artifacts.find((artifact) => artifact.name.endsWith('.dmg'))?.size).toBe(
      'stapled-final-dmg'.length,
    );
    expect(inventory.files.map((file) => file.path)).toContain(
      'Contents/Resources/cua-driver/cua-driver',
    );
    expect(run.mock.calls.some(([, args]) => args[0] === 'detach')).toBe(true);
  });

  it('validates the notarized DMG once while retaining both contained-app ticket checks', async () => {
    const directory = await createRelease();
    const dmg = join(directory, 'Tro-0.1.1-macos-arm64.dmg');
    const run = vi.fn<MacCommand>(acceptedNotaryCommand);
    await verifyMacRelease(directory, macSettings, '0.1.1', run, (path, settings) =>
      notarizeMacDmg(path, settings, {
        run,
        now: () => 0,
        wait: () => Promise.resolve(),
      }),
    );
    const validations = run.mock.calls.filter(
      ([, args]) => args[0] === 'stapler' && args[1] === 'validate',
    );
    expect(validations.filter(([, args]) => args[2] === dmg)).toEqual([
      ['/usr/bin/xcrun', ['stapler', 'validate', dmg]],
    ]);
    expect(validations.filter(([, args]) => args[2]?.endsWith('/Tro.app'))).toHaveLength(2);
    const validationIndex = run.mock.calls.findIndex(
      ([, args]) => args[0] === 'stapler' && args[1] === 'validate' && args[2] === dmg,
    );
    const gatekeeperIndex = run.mock.calls.findIndex(
      ([executable, args]) => executable.endsWith('/spctl') && args.at(-1) === dmg,
    );
    expect(gatekeeperIndex).toBeGreaterThan(validationIndex);
    expect(run.mock.calls.some(([, args]) => args[0] === 'detach')).toBe(true);
    await expect(readFile(join(directory, 'MacSignatures-arm64.json'))).resolves.toBeDefined();
  });

  it.each(['staple', 'validate'])(
    'rejects an accepted DMG when its mandatory %s step fails',
    async (step) => {
      const directory = await createRelease();
      const dmg = join(directory, 'Tro-0.1.1-macos-arm64.dmg');
      await writeFile(join(directory, 'MacSignatures-arm64.json'), 'old-success');
      const run = vi.fn<MacCommand>((executable, args) => {
        if (args[0] === 'stapler' && args[1] === step && args[2] === dmg) {
          return Promise.reject(new Error('ticket step failed'));
        }
        return acceptedNotaryCommand(executable, args);
      });
      await expect(
        verifyMacRelease(directory, macSettings, '0.1.1', run, (path, settings) =>
          notarizeMacDmg(path, settings, {
            run,
            now: () => 0,
            wait: () => Promise.resolve(),
          }),
        ),
      ).rejects.toThrow('ticket step failed');
      expect(run).toHaveBeenCalledWith('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
      expect(
        run.mock.calls.some(
          ([executable, args]) => executable.endsWith('/spctl') && args.at(-1) === dmg,
        ),
      ).toBe(false);
      expect(run.mock.calls.some(([, args]) => args[0] === 'attach')).toBe(false);
      await expect(readFile(join(directory, 'MacSignatures-arm64.json'))).rejects.toThrow();
    },
  );

  it.each(['Renderer', 'GPU', 'Plugin'])(
    'checks parenthesized %s helper names as literal paths',
    async (kind) => {
      const directory = await createRelease();
      const helperName = `Tro Helper (${kind})`;
      const helperPath = join(
        'Contents',
        'Frameworks',
        `${helperName}.app`,
        'Contents',
        'MacOS',
        helperName,
      );
      const run = vi.fn<MacCommand>(async (executable, args) => {
        const result = await archiveCommand(executable, args);
        if (
          executable.endsWith('ditto') ||
          (executable.endsWith('hdiutil') && args[0] === 'attach')
        ) {
          const destination = join(z.string().parse(args.at(-1)), 'Tro.app', helperPath);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, Buffer.from('cffaedfe00000000', 'hex'));
        }
        return result;
      });
      await verifyMacRelease(directory, macSettings, '0.1.1', run, () =>
        Promise.resolve(submissionId),
      );
      const commands = run.mock.calls.filter(
        ([executable, args]) =>
          executable === '/usr/bin/otool' && args.at(-1)?.endsWith(helperPath),
      );
      expect(commands).toHaveLength(2);
      for (const [, args] of commands) {
        expect(args).toEqual(['-m', '-l', expect.stringContaining(helperPath)]);
      }
    },
  );

  it('detaches and leaves no success inventory after inconsistent archives', async () => {
    const directory = await createRelease();
    await writeFile(join(directory, 'MacSignatures-arm64.json'), 'old-success');
    const run = vi.fn<MacCommand>(async (exe, args) => {
      const result = await archiveCommand(exe, args);
      if (args[0] === 'attach') {
        await writeFile(
          join(
            z.string().parse(args.at(-1)),
            'Tro.app',
            'Contents',
            'Resources',
            'cua-driver',
            'cua-driver',
          ),
          Buffer.from('cffaedfe12345678', 'hex'),
        );
      }
      return result;
    });
    await expect(
      verifyMacRelease(directory, macSettings, '0.1.1', run, () => Promise.resolve(submissionId)),
    ).rejects.toThrow('different');
    expect(run.mock.calls.some(([, args]) => args[0] === 'detach')).toBe(true);
    await expect(readFile(join(directory, 'MacSignatures-arm64.json'))).rejects.toThrow();
  });

  it('rejects an empty artifact before notarization', async () => {
    const directory = await createRelease();
    await writeFile(join(directory, artifactNames[0] ?? ''), '');
    const notarize = vi.fn<(path: string) => Promise<string>>();
    await expect(
      verifyMacRelease(directory, macSettings, '0.1.1', archiveCommand, notarize),
    ).rejects.toThrow('empty');
    expect(notarize).not.toHaveBeenCalled();
  });

  it('rejects missing app contents and incompatible minimum macOS', async () => {
    const directory = await createRelease();
    const run: MacCommand = async (exe, args) => {
      if (exe.endsWith('otool')) {
        return { stdout: 'cmd LC_BUILD_VERSION\nminos 14.0', stderr: '' };
      }
      return archiveCommand(exe, args);
    };
    await expect(verifyMacRelease(directory, macSettings, '0.1.1', run)).rejects.toThrow(
      'minimum version',
    );
    await expect(
      verifyMacRelease(directory, macSettings, '0.1.1', async (exe, args) => {
        if (exe.endsWith('ditto')) {
          await mkdir(join(z.string().parse(args.at(-1)), 'Tro.app'));
        }
        return macCommand(exe, args);
      }),
    ).rejects.toThrow();
  });
});
