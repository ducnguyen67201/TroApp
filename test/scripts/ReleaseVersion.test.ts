import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDesktopReleaseVersion,
  incrementPatchVersion,
  prepareDesktopRelease,
  ReleasePreparationStage,
} from '../../scripts/ReleaseVersion.js';
import { readReleaseBuildEnv, readReleasePreparationEnv } from '../../scripts/Env.js';

const runFile = promisify(execFile);
const temporaryDirectories: string[] = [];

async function runGit(workspace: string, gitArguments: string[]): Promise<string> {
  const result = await runFile('git', gitArguments, { cwd: workspace });
  return result.stdout.trim();
}

async function createRepository(): Promise<{
  workspace: string;
  remote: string;
  sourceCommit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'TroReleaseVersion-'));
  temporaryDirectories.push(root);
  const remote = join(root, 'Remote.git');
  const workspace = join(root, 'Checkout');
  await runGit(root, ['init', '--bare', remote]);
  await runGit(root, ['init', '--initial-branch=main', workspace]);
  await runGit(workspace, ['config', 'user.name', 'Release Fixture']);
  await runGit(workspace, ['config', 'user.email', 'release@example.test']);
  await runGit(workspace, ['config', 'core.autocrlf', 'false']);
  await runGit(workspace, ['remote', 'add', 'origin', remote]);
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify(
      { name: 'tro-fixture', version: '0.1.0', scripts: { example: 'preserved' } },
      null,
      2,
    ) + '\n',
  );
  await runGit(workspace, ['add', 'package.json']);
  await runGit(workspace, ['commit', '-m', 'Initial fixture']);
  await runGit(workspace, ['push', 'origin', 'main']);
  return { workspace, remote, sourceCommit: await runGit(workspace, ['rev-parse', 'HEAD']) };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    /* Every cleanup target comes directly from this suite's mkdtemp call. */
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) {
      throw new Error('Release fixture cleanup escaped its temporary root.');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}, 20_000);

describe('desktop patch versions', () => {
  it('increments the patch and preserves major/minor versions', () => {
    expect(incrementPatchVersion('0.1.0')).toBe('0.1.1');
    expect(incrementPatchVersion('3.12.99')).toBe('3.12.100');
  });

  it.each(['v0.1.0', '0.1', '0.1.0-beta', '0.01.0', '0.1.65535', '65536.1.0'])(
    'rejects unsupported or overflowing versions: %s',
    (version) => {
      expect(() => incrementPatchVersion(version)).toThrow();
    },
  );

  it('validates release job configuration without exposing rejected values', () => {
    const environment = {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '123',
      GITHUB_OUTPUT: resolve('Output.txt'),
    };
    expect(readReleasePreparationEnv(environment)).toEqual({
      sourceCommit: environment.GITHUB_SHA,
      runId: '123',
      outputPath: environment.GITHUB_OUTPUT,
    });
    expect(() =>
      readReleasePreparationEnv({ ...environment, GITHUB_REF: 'private-ref-value' }),
    ).toThrow('Desktop release preparation configuration is invalid.');
    expect(() =>
      readReleasePreparationEnv({ ...environment, GITHUB_OUTPUT: 'relative-output' }),
    ).toThrow('Desktop release preparation configuration is invalid.');
  });
});

describe('persisted desktop release versions', () => {
  it('reserves one patch tag without changing main or its manifest and reuses it after later work', async () => {
    const repository = await createRepository();
    const before = await readFile(join(repository.workspace, 'package.json'), 'utf8');
    const stages: ReleasePreparationStage[] = [];
    const release = await prepareDesktopRelease({
      ...repository,
      runId: '120',
      recordStage: (stage) => stages.push(stage),
    });
    expect(release).toEqual({
      version: '0.1.1',
      tag: 'desktop-v0.1.1',
      commit: repository.sourceCommit,
    });
    expect(await runGit(repository.workspace, ['rev-parse', 'origin/main'])).toBe(
      repository.sourceCommit,
    );
    expect(await readFile(join(repository.workspace, 'package.json'), 'utf8')).toBe(before);
    expect(stages).toEqual([
      ReleasePreparationStage.CHECK,
      ReleasePreparationStage.RESERVE,
      ReleasePreparationStage.PUBLISH,
    ]);
    await writeFile(join(repository.workspace, 'Later.txt'), 'later work');
    await runGit(repository.workspace, ['add', 'Later.txt']);
    await runGit(repository.workspace, ['commit', '-m', 'Later unrelated work']);
    await runGit(repository.workspace, ['push', 'origin', 'main']);
    const laterCommit = await runGit(repository.workspace, ['rev-parse', 'HEAD']);
    stages.length = 0;
    expect(
      await prepareDesktopRelease({
        ...repository,
        runId: '120',
        recordStage: (stage) => stages.push(stage),
      }),
    ).toEqual(release);
    expect(await runGit(repository.workspace, ['rev-parse', 'origin/main'])).toBe(laterCommit);
    expect(stages).toEqual([ReleasePreparationStage.CHECK, ReleasePreparationStage.REUSE]);
    await expect(
      prepareDesktopRelease({ ...repository, sourceCommit: laterCommit, runId: '120' }),
    ).rejects.toThrow('Release reservation does not match the requested source.');
  }, 120_000);

  it('allocates a new version for a new run on the same source and distinguishes run ID prefixes', async () => {
    const repository = await createRepository();
    const first = await prepareDesktopRelease({ ...repository, runId: '1230' });
    const second = await prepareDesktopRelease({ ...repository, runId: '123' });
    expect(first.version).toBe('0.1.1');
    expect(second.version).toBe('0.1.2');
    expect(second.commit).toBe(first.commit);
    expect(second.tag).not.toBe(first.tag);
  }, 120_000);

  it('compares reserved patch versions numerically', async () => {
    const repository = await createRepository();
    for (const [version, runId] of [
      ['0.1.9', '200'],
      ['0.1.10', '201'],
    ] as const) {
      await runGit(repository.workspace, [
        'tag',
        '-a',
        '-m',
        `Desktop ${version}`,
        '-m',
        `Tro-Release-Run: ${runId}\nTro-Release-Source: ${repository.sourceCommit}`,
        `desktop-v${version}`,
      ]);
      await runGit(repository.workspace, ['push', 'origin', `refs/tags/desktop-v${version}`]);
    }
    expect((await prepareDesktopRelease({ ...repository, runId: '202' })).version).toBe('0.1.11');
  }, 120_000);

  it('applies the reserved build version while preserving other metadata and the committed baseline', async () => {
    const repository = await createRepository();
    await applyDesktopReleaseVersion(repository.workspace, '0.1.1');
    expect(await readFile(join(repository.workspace, 'package.json'), 'utf8')).toBe(
      JSON.stringify(
        { name: 'tro-fixture', version: '0.1.1', scripts: { example: 'preserved' } },
        null,
        2,
      ) + '\n',
    );
    expect(await runGit(repository.workspace, ['show', 'HEAD:package.json'])).toContain(
      '"version": "0.1.0"',
    );
    expect(
      readReleaseBuildEnv({ GITHUB_ACTIONS: 'true', TRO_DESKTOP_RELEASE_VERSION: '0.1.1' }),
    ).toEqual({ version: '0.1.1' });
    expect(() =>
      readReleaseBuildEnv({ GITHUB_ACTIONS: 'true', TRO_DESKTOP_RELEASE_VERSION: '0.1.65536' }),
    ).toThrow('Desktop release build configuration is invalid.');
  }, 120_000);

  it('refuses a stale source commit before reserving a tag', async () => {
    const repository = await createRepository();
    await writeFile(join(repository.workspace, 'Later.txt'), 'later work');
    await runGit(repository.workspace, ['add', 'Later.txt']);
    await runGit(repository.workspace, ['commit', '-m', 'Later work']);
    await runGit(repository.workspace, ['push', 'origin', 'main']);
    await expect(prepareDesktopRelease({ ...repository, runId: '130' })).rejects.toThrow(
      'Main changed before release preparation',
    );
    expect(
      await runGit(repository.workspace, ['ls-remote', 'origin', 'refs/tags/desktop-v*']),
    ).toBe('');
  }, 120_000);

  it('refuses dirty workspaces', async () => {
    const repository = await createRepository();
    await writeFile(join(repository.workspace, 'Existing.txt'), 'preserve this work');
    await expect(prepareDesktopRelease({ ...repository, runId: '131' })).rejects.toThrow(
      'clean checkout',
    );
    expect(await readFile(join(repository.workspace, 'Existing.txt'), 'utf8')).toBe(
      'preserve this work',
    );
  }, 120_000);

  it('preserves main when another commit lands during tag publication', async () => {
    const repository = await createRepository();
    await writeFile(join(repository.workspace, 'Other.txt'), 'other work');
    await runGit(repository.workspace, ['add', 'Other.txt']);
    await runGit(repository.workspace, ['commit', '-m', 'Competing work']);
    const otherCommit = await runGit(repository.workspace, ['rev-parse', 'HEAD']);
    await runGit(repository.workspace, ['push', 'origin', 'HEAD:competing']);
    await runGit(repository.workspace, ['checkout', '--detach', repository.sourceCommit]);
    const release = await prepareDesktopRelease({
      ...repository,
      runId: '132',
      recordStage: (stage) => {
        if (stage === ReleasePreparationStage.PUBLISH) {
          execFileSync('git', [
            '--git-dir',
            repository.remote,
            'update-ref',
            'refs/heads/main',
            otherCommit,
          ]);
        }
      },
    });
    expect(release.commit).toBe(repository.sourceCommit);
    expect(await runGit(repository.workspace, ['ls-remote', 'origin', 'refs/heads/main'])).toBe(
      `${otherCommit}\trefs/heads/main`,
    );
  }, 120_000);

  it('never overwrites a competing tag reservation', async () => {
    const repository = await createRepository();
    await writeFile(join(repository.workspace, 'Other.txt'), 'other work');
    await runGit(repository.workspace, ['add', 'Other.txt']);
    await runGit(repository.workspace, ['commit', '-m', 'Competing work']);
    const otherCommit = await runGit(repository.workspace, ['rev-parse', 'HEAD']);
    await runGit(repository.workspace, ['push', 'origin', 'HEAD:competing']);
    await runGit(repository.workspace, ['checkout', '--detach', repository.sourceCommit]);
    await expect(
      prepareDesktopRelease({
        ...repository,
        runId: '133',
        recordStage: (stage) => {
          if (stage === ReleasePreparationStage.PUBLISH) {
            execFileSync('git', [
              '--git-dir',
              repository.remote,
              'update-ref',
              'refs/tags/desktop-v0.1.1',
              otherCommit,
            ]);
          }
        },
      }),
    ).rejects.toThrow('Desktop release Git operation failed: push.');
    expect(
      await runGit(repository.workspace, ['ls-remote', 'origin', 'refs/tags/desktop-v0.1.1']),
    ).toBe(`${otherCommit}\trefs/tags/desktop-v0.1.1`);
  }, 120_000);

  it('retries an unpublished local reservation without claiming success or consuming another version', async () => {
    const repository = await createRepository();
    await expect(
      prepareDesktopRelease({
        ...repository,
        runId: '134',
        recordStage: (stage) => {
          if (stage === ReleasePreparationStage.PUBLISH) {
            throw new Error('Interrupted before push.');
          }
        },
      }),
    ).rejects.toThrow('Interrupted before push.');
    expect(
      await runGit(repository.workspace, ['ls-remote', 'origin', 'refs/tags/desktop-v0.1.1']),
    ).toBe('');
    const release = await prepareDesktopRelease({ ...repository, runId: '134' });
    expect(release.version).toBe('0.1.1');
    expect(await prepareDesktopRelease({ ...repository, runId: '134' })).toEqual(release);
  }, 120_000);
});
