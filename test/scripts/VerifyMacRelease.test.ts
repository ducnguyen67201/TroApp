import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  notarizeMacDmg,
  selectMacArtifacts,
  verifyMacRelease,
} from '../../scripts/VerifyMacRelease.js';
import type { MacCommand } from '../../scripts/MacSigning.js';
import { createMacFixture, macCommand, macSettings } from './MacReleaseFixtures.js';

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
    expect(wait).toHaveBeenCalledWith(15_000);
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['stapler', 'validate', '/fixture.dmg']);
  });

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
  it('selects exact version/architecture and rejects stale files or feed metadata', () => {
    expect(selectMacArtifacts(artifactNames, '0.1.1', 'arm64')).toEqual({
      dmg: artifactNames[0],
      zip: artifactNames[1],
    });
    for (const names of [
      [],
      artifactNames.slice(0, 1),
      [...artifactNames, 'old.dmg'],
      [...artifactNames, 'latest-mac.yml'],
    ]) {
      expect(() => selectMacArtifacts(names, '0.1.1', 'arm64')).toThrow('artifacts');
    }
    expect(() => selectMacArtifacts(artifactNames, '../escape', 'arm64')).toThrow();
    expect(() => selectMacArtifacts(artifactNames, '0.1.1', 'x64')).toThrow();
  });

  it('verifies extracted app and mounted app, then hashes final stapled bytes', async () => {
    const directory = await createRelease();
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
