import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MacUpdater } from 'electron-updater/out/MacUpdater.js';
import {
  findFile,
  parseUpdateInfo,
  resolveFiles,
} from 'electron-updater/out/providers/Provider.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readReleasePublishingEnv } from '../../scripts/Env.js';
import {
  publishDesktopRelease,
  type ReleaseCommand,
  type ReleasePublishOptions,
} from '../../scripts/PublishDesktopRelease.js';

const environment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'ducnguyen67201/TroApp',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
};
const temporary: string[] = [];

/** Exercise the updater's protected architecture selection without constructing native Electron. */
class FixtureMacUpdater extends MacUpdater {
  static selectZipForArchitecture(files: ReturnType<typeof resolveFiles>, isArm64: boolean) {
    return findFile(this.filterFilesForArch(files, isArm64), 'zip', ['dmg']);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'tro-publish-test-'));
  temporary.push(root);
  const directory = join(root, 'verified');
  const packagePath = join(root, 'package.json');
  await mkdir(directory);
  await writeFile(packagePath, JSON.stringify({ version: '0.1.1' }));
  const directories = {
    macosApple: join(directory, `Tro-0.1.1-macos-arm64-${environment.GITHUB_SHA}-12345-1`),
    macosIntel: join(directory, `Tro-0.1.1-macos-x64-${environment.GITHUB_SHA}-12345-1`),
    windows: join(directory, `Tro-0.1.1-windows-x64-${environment.GITHUB_SHA}-12345-1`),
  };
  for (const [architecture, path] of [
    ['arm64', directories.macosApple],
    ['x64', directories.macosIntel],
  ]) {
    if (!path || !architecture) {
      throw new Error('Invalid fixture architecture');
    }
    await mkdir(path);
    const artifacts = [];
    for (const format of ['dmg', 'zip']) {
      const name = `Tro-0.1.1-macos-${architecture}.${format}`;
      const bytes = Buffer.from(`verified ${name}`);
      await writeFile(join(path, name), bytes);
      artifacts.push({
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    await writeFile(
      join(path, `MacSignatures-${architecture}.json`),
      JSON.stringify({
        version: '0.1.1',
        architecture,
        status: 'verified',
        artifacts,
      }),
    );
  }
  await mkdir(directories.windows);
  const installer = 'Tro-0.1.1-windows-x64-setup.exe';
  const bytes = Buffer.from('signed Windows installer');
  await writeFile(join(directories.windows, installer), bytes);
  await writeFile(join(directories.windows, `${installer}.blockmap`), 'blockmap');
  // Native-resource records need not have a timestamp; PowerShell may write a UTF-8 BOM.
  await writeFile(
    join(directories.windows, 'WindowsSignatures.json'),
    '\uFEFF' +
      JSON.stringify([
        {
          path: installer,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          status: 'Valid',
          timestamped: true,
        },
        {
          path: 'win-unpacked/vendor.dll',
          sha256: 'b'.repeat(64),
          status: 'Valid',
          timestamped: false,
        },
      ]),
  );
  const uploadedManifests = new Map<string, Buffer>();
  const readUploadedRelease = async () => ({
    draft: true,
    prerelease: false,
    tag_name: 'release-v0.1.1-aaaaaaaaaaaa-12345-1',
    target_commitish: environment.GITHUB_SHA,
    assets: (
      await Promise.all(
        Object.values(directories).map(async (path) =>
          Promise.all(
            (await readdir(path))
              .filter((name) => name !== 'latest.yml')
              .map(async (name) => {
                const bytes = await readFile(join(path, name));
                return {
                  name,
                  size: bytes.length,
                  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                  state: 'uploaded',
                };
              }),
          ),
        ),
      )
    )
      .flat()
      .concat(
        [...uploadedManifests].map(([name, bytes]) => ({
          name,
          size: bytes.length,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          state: 'uploaded',
        })),
      ),
  });
  let releaseTag = 'release-v0.1.1-aaaaaaaaaaaa-12345-1';
  const run = vi.fn<ReleaseCommand>(async (arguments_) => {
    if (arguments_[0] === 'release' && arguments_[1] === 'upload') {
      for (const path of arguments_.slice(5)) {
        if (path.endsWith('.yml')) {
          uploadedManifests.set(basename(path), await readFile(path));
        }
      }
    }
    if (arguments_[0] === 'release' && arguments_[1] === 'view') {
      releaseTag = z.string().parse(arguments_[2]);
      return JSON.stringify({ databaseId: 98765 });
    }
    if (arguments_[0] !== 'api') {
      return '';
    }
    // Drafts cannot be fetched through the REST tag endpoint, even with write access.
    if (arguments_[1] !== 'repos/ducnguyen67201/TroApp/releases/98765') {
      throw new Error('Draft release lookup requires its numeric ID.');
    }
    return JSON.stringify({
      ...(await readUploadedRelease()),
      tag_name: releaseTag,
    });
  });
  const publish = (
    settings: NodeJS.ProcessEnv = environment,
    options: ReleasePublishOptions = {},
  ) => publishDesktopRelease(directory, packagePath, settings, run, options);
  return {
    directory,
    directories,
    packagePath,
    run,
    publish,
    readUploadedRelease,
    uploadedManifests,
  };
}

describe('desktop release publication', () => {
  it('publishes all three targets from a draft only after remote hash verification', async () => {
    const { publish, run, directories } = await createFixture();
    expect(await publish()).toBe(
      'https://github.com/ducnguyen67201/TroApp/releases/tag/release-v0.1.1-aaaaaaaaaaaa-12345-1',
    );
    expect(run.mock.calls.map(([arguments_]) => arguments_.slice(0, 2))).toEqual([
      ['release', 'create'],
      ['release', 'upload'],
      ['release', 'view'],
      ['api', 'repos/ducnguyen67201/TroApp/releases/98765'],
      ['release', 'edit'],
    ]);
    expect(run.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['--draft', '--target', environment.GITHUB_SHA, '--latest=false']),
    );
    expect(run.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        join(directories.macosApple, 'Tro-0.1.1-macos-arm64.dmg'),
        join(directories.macosIntel, 'Tro-0.1.1-macos-x64.dmg'),
        join(directories.windows, 'Tro-0.1.1-windows-x64-setup.exe'),
      ]),
    );
    expect(run.mock.calls.at(-1)?.[0]).toContain('--draft=false');
    expect(run.mock.calls.at(-1)?.[0]).toContain('--latest=true');
    expect(run.mock.calls.flat(2)).not.toContain('--clobber');
    // Publication tags cannot enter the version allocator's reserved desktop-v* namespace.
    expect(run.mock.calls[0]?.[0][2]).not.toMatch(/^desktop-v/);
  });

  it('resumes a fully uploaded draft after verifying the original local files', async () => {
    const { publish, run } = await createFixture();
    await publish();
    run.mockClear();
    await publish(environment, { resume: true });
    expect(run.mock.calls.map(([arguments_]) => arguments_.slice(0, 2))).toEqual([
      ['release', 'view'],
      ['api', 'repos/ducnguyen67201/TroApp/releases/98765'],
      ['release', 'edit'],
    ]);
    expect(run.mock.calls[0]?.[0][2]).toBe('release-v0.1.1-aaaaaaaaaaaa-12345-1');
    expect(run.mock.calls.at(-1)?.[0]).toContain('--draft=false');
  });

  it.each(['missing', 'invalid-id', 'incomplete', 'changed', 'commit', 'published'])(
    'refuses to resume an unsafe draft: %s',
    async (mode) => {
      const { publish, run, readUploadedRelease } = await createFixture();
      await publish();
      run.mockClear();
      const uploaded = await readUploadedRelease();
      const asset = uploaded.assets[0];
      if (!asset) {
        throw new Error('Missing fixture asset');
      }
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      if (mode === 'missing') {
        run.mockRejectedValueOnce(new Error('Draft not found'));
      } else if (mode === 'invalid-id') {
        run.mockResolvedValueOnce(JSON.stringify({ databaseId: '../tags/untrusted' }));
      } else {
        if (mode === 'incomplete') {
          uploaded.assets.pop();
        } else if (mode === 'changed') {
          asset.digest = `sha256:${'b'.repeat(64)}`;
        } else if (mode === 'commit') {
          uploaded.target_commitish = 'b'.repeat(40);
        } else {
          uploaded.draft = false;
        }
        run
          .mockResolvedValueOnce(JSON.stringify({ databaseId: 98765 }))
          .mockResolvedValueOnce(JSON.stringify(uploaded));
      }
      await expect(publish(environment, { resume: true })).rejects.toThrow();
      expect(
        run.mock.calls.every(([arguments_]) => arguments_[0] === 'api' || arguments_[1] === 'view'),
      ).toBe(true);
      if (['incomplete', 'changed', 'commit', 'published'].includes(mode)) {
        expect(diagnostic).toHaveBeenCalledWith(
          expect.stringContaining('release.publish.upload.rejected'),
        );
      }
    },
  );

  it('replaces builder metadata with a feed for the final signed installer', async () => {
    const { publish, directories, run, uploadedManifests } = await createFixture();
    const path = join(directories.windows, 'latest.yml');
    await writeFile(path, 'verified metadata');
    await publish();
    expect(run.mock.calls[1]?.[0]).not.toContain(path);
    expect(uploadedManifests.get('latest.yml')?.toString()).not.toContain('verified metadata');
  });

  it('publishes feeds understood by the installed updater for both Mac architectures and Windows', async () => {
    const { publish, uploadedManifests, directories, run } = await createFixture();
    await publish();
    const feedUrl = new URL('https://github.com/ducnguyen67201/TroApp/releases/latest/download/');
    const releaseUrl =
      'https://github.com/ducnguyen67201/TroApp/releases/download/release-v0.1.1-aaaaaaaaaaaa-12345-1/';
    expect([...uploadedManifests.keys()].sort()).toEqual(['latest-mac.yml', 'latest.yml']);
    for (const name of ['latest-mac.yml', 'latest.yml']) {
      const content = uploadedManifests.get(name);
      if (!content) {
        throw new Error('Missing update manifest');
      }
      const metadata = parseUpdateInfo(content.toString(), name, new URL(name, feedUrl));
      expect(metadata.version).toBe('0.1.1');
      const files = resolveFiles(metadata, feedUrl);
      expect(files).toHaveLength(name === 'latest-mac.yml' ? 4 : 1);
      for (const file of files) {
        expect(file.url.href.startsWith(releaseUrl)).toBe(true);
        const artifactName = basename(file.url.pathname);
        const directory = file.url.pathname.includes('macos-arm64')
          ? directories.macosApple
          : file.url.pathname.includes('macos-x64')
            ? directories.macosIntel
            : directories.windows;
        const bytes = await readFile(join(directory, artifactName));
        expect(file.info.sha512).toBe(createHash('sha512').update(bytes).digest('base64'));
        expect(file.info.size).toBe(bytes.length);
      }
      if (name === 'latest-mac.yml') {
        for (const [isArm64, architecture] of [
          [true, 'arm64'],
          [false, 'x64'],
        ] as const) {
          const selected = FixtureMacUpdater.selectZipForArchitecture(files, isArm64);
          expect(selected?.url.href).toBe(`${releaseUrl}Tro-0.1.1-macos-${architecture}.zip`);
        }
      } else {
        expect(findFile(files, 'exe')?.url.href).toBe(
          `${releaseUrl}Tro-0.1.1-windows-x64-setup.exe`,
        );
      }
    }
    // Transient manifest files are removed after publication; resume regenerates identical bytes.
    const paths = run.mock.calls[1]?.[0].filter((argument) => argument.endsWith('.yml')) ?? [];
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      await expect(readFile(path)).rejects.toThrow();
    }
  });

  it('uses unique publication tags across attempts without rebuilding successful targets', async () => {
    const { publish, run } = await createFixture();
    await publish();
    await publish({ ...environment, GITHUB_RUN_ATTEMPT: '2' });
    const creates = run.mock.calls.filter(([arguments_]) => arguments_[1] === 'create');
    expect(new Set(creates.map(([arguments_]) => arguments_[2])).size).toBe(2);
  });

  it('selects the newest artifact for each target numerically across failed-job retries', async () => {
    const { publish, run, directories } = await createFixture();
    const newest = directories.macosIntel.slice(0, -1) + '10';
    await cp(directories.macosIntel, newest, { recursive: true });
    await cp(directories.macosIntel, directories.macosIntel.slice(0, -1) + '9', {
      recursive: true,
    });
    await publish({ ...environment, GITHUB_RUN_ATTEMPT: '10' });
    expect(run.mock.calls[1]?.[0]).toContain(join(newest, 'Tro-0.1.1-macos-x64.dmg'));
    expect(run.mock.calls[1]?.[0]).not.toContain(
      join(directories.macosIntel, 'Tro-0.1.1-macos-x64.dmg'),
    );
    expect(run.mock.calls[1]?.[0]).toContain(
      join(directories.windows, 'Tro-0.1.1-windows-x64-setup.exe'),
    );
  });

  it.each([
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'another/repository' },
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_SHA: 'main' },
    { GITHUB_RUN_ATTEMPT: '0' },
  ])('rejects unauthorized publishing context %j before any remote command', async (overrides) => {
    const { publish, run } = await createFixture();
    await expect(publish({ ...environment, ...overrides })).rejects.toThrow('workflow dispatch');
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['macosApple', 'macosIntel', 'windows'] as const)(
    'does not create a draft without %s artifacts',
    async (target) => {
      const { publish, run, directories } = await createFixture();
      await rm(directories[target], { recursive: true });
      await expect(publish()).rejects.toThrow('required desktop target');
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(['macosApple', 'windows'] as const)(
    'rejects changed %s installer bytes',
    async (target) => {
      const { publish, run, directories } = await createFixture();
      const name =
        target === 'macosApple' ? 'Tro-0.1.1-macos-arm64.dmg' : 'Tro-0.1.1-windows-x64-setup.exe';
      await writeFile(join(directories[target], name), 'changed after verification');
      await expect(publish()).rejects.toThrow('inventory');
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each([
    'extra',
    'empty',
    'symlink',
    'version',
    'other-run',
    'future-attempt',
    'invalid-attempt',
  ])('rejects invalid artifact set: %s', async (mode) => {
    const { publish, run, directory, directories, packagePath } = await createFixture();
    const path = join(directories.macosApple, 'Tro-0.1.1-macos-arm64.dmg');
    if (mode === 'extra') {
      await writeFile(join(directories.macosApple, 'unverified.exe'), 'unexpected');
    } else if (mode === 'empty') {
      await writeFile(path, '');
    } else if (mode === 'symlink') {
      await rm(path);
      await symlink(packagePath, path);
    } else if (mode === 'version') {
      await writeFile(packagePath, JSON.stringify({ version: '0.1.2' }));
    } else if (mode === 'other-run') {
      await mkdir(join(directory, `Tro-0.1.1-windows-x64-${environment.GITHUB_SHA}-99999-1`));
    } else {
      await cp(
        directories.windows,
        directories.windows.slice(0, -1) + (mode === 'future-attempt' ? '2' : 'invalid'),
        { recursive: true },
      );
    }
    await expect(publish()).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['create', 'upload', 'view', 'api'])(
    'never publishes when the %s command fails',
    async (stage) => {
      const { publish, run } = await createFixture();
      const successful = run.getMockImplementation();
      run.mockImplementation((arguments_) => {
        if (arguments_[1] === stage || arguments_[0] === stage) {
          return Promise.reject(new Error('simulated command failure'));
        }
        if (!successful) {
          throw new Error('Missing test command');
        }
        return successful(arguments_);
      });
      await expect(publish()).rejects.toThrow('simulated command failure');
      expect(run.mock.calls.some(([arguments_]) => arguments_.includes('--draft=false'))).toBe(
        false,
      );
    },
  );

  it.each([
    'digest',
    'manifest-digest',
    'size',
    'missing',
    'duplicate',
    'commit',
    'draft',
    'prerelease',
    'malformed',
  ])('leaves the release unpublished when remote metadata differs: %s', async (mode) => {
    const { publish, run, readUploadedRelease } = await createFixture();
    await publish();
    run.mockClear();
    const uploaded = await readUploadedRelease();
    const asset = uploaded.assets[0];
    if (!asset) {
      throw new Error('Missing fixture asset');
    }
    if (mode === 'digest') {
      asset.digest = `sha256:${'b'.repeat(64)}`;
    } else if (mode === 'manifest-digest') {
      const manifest = uploaded.assets.find((candidate) => candidate.name === 'latest-mac.yml');
      if (!manifest) {
        throw new Error('Missing fixture manifest');
      }
      manifest.digest = `sha256:${'b'.repeat(64)}`;
    } else if (mode === 'size') {
      asset.size += 1;
    } else if (mode === 'missing') {
      uploaded.assets.pop();
    } else if (mode === 'duplicate') {
      uploaded.assets[1] = asset;
    } else if (mode === 'commit') {
      uploaded.target_commitish = 'b'.repeat(40);
    } else if (mode === 'draft') {
      uploaded.draft = false;
    } else if (mode === 'prerelease') {
      uploaded.prerelease = true;
    }
    run
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ databaseId: 98765 }))
      .mockResolvedValueOnce(JSON.stringify(mode === 'malformed' ? {} : uploaded));
    await expect(publish()).rejects.toThrow();
    expect(run.mock.calls.some(([arguments_]) => arguments_.includes('--draft=false'))).toBe(false);
  });

  it('never exposes environment inputs in validation failures', () => {
    expect(() => readReleasePublishingEnv({ ...environment, GITHUB_SHA: 'private-value' })).toThrow(
      'Release publishing requires a main-branch TroApp workflow dispatch.',
    );
  });
});
