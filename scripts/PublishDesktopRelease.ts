import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { readReleasePublishingEnv } from './Env.js';
import { DesktopReleaseVersionSchema } from './ReleaseVersion.js';

const ReleasePlatform = { MACOS: 'macos', WINDOWS: 'windows' } as const;
type ReleasePlatform = (typeof ReleasePlatform)[keyof typeof ReleasePlatform];
const ReleaseTarget = {
  MACOS_ARM64: 'macos-arm64',
  MACOS_X64: 'macos-x64',
  WINDOWS_X64: 'windows-x64',
} as const;
const FileDigestSchema = z.object({
  name: z.string(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type ReleaseFile = z.infer<typeof FileDigestSchema> & { path: string };
export type ReleaseCommand = (arguments_: readonly string[]) => Promise<string>;

export type ReleasePublishOptions = { resume?: boolean };
const executeFile = promisify(execFile);

/** Command output can include credentials or arbitrary remote diagnostics; keep failures bounded. */
const runReleaseCommand: ReleaseCommand = async (arguments_) => {
  try {
    const result = await executeFile('gh', [...arguments_], { timeout: 5 * 60 * 1000 });
    return result.stdout;
  } catch (error) {
    const exitCode =
      error instanceof Error && 'code' in error && typeof error.code === 'number'
        ? error.code
        : undefined;
    console.error(
      JSON.stringify({
        event: 'release.publish.command.failed',
        command: arguments_[0],
        operation: arguments_[0] === 'release' ? arguments_[1] : undefined,
        exitCode,
      }),
    );
    throw new Error(
      'GitHub release command failed. Inspect the last release.publish.stage event.',
      {
        cause: error,
      },
    );
  }
};

async function readReleaseJson(path: string): Promise<unknown> {
  const value: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  return value;
}

/** Only exact expected files from the successful packaging jobs may become public assets. */
async function readReleaseFiles(
  directory: string,
  platform: ReleasePlatform,
  version: string,
  architecture: 'arm64' | 'x64' | undefined,
): Promise<ReleaseFile[]> {
  const names = await readdir(directory);
  const architectures = architecture ? [architecture] : [];
  const required =
    platform === ReleasePlatform.MACOS
      ? architectures.flatMap((architecture) => [
          `Tro-${version}-macos-${architecture}.dmg`,
          `Tro-${version}-macos-${architecture}.zip`,
          `MacSignatures-${architecture}.json`,
        ])
      : [
          `Tro-${version}-windows-x64-setup.exe`,
          `Tro-${version}-windows-x64-setup.exe.blockmap`,
          'WindowsSignatures.json',
        ];
  const expected =
    platform === ReleasePlatform.WINDOWS && names.includes('latest.yml')
      ? [...required, 'latest.yml']
      : required;
  if (names.length !== expected.length || expected.some((name) => !names.includes(name))) {
    throw new Error('Release files do not match the expected platform and version.');
  }
  const files: ReleaseFile[] = [];
  for (const name of expected) {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile()) {
      throw new Error('Release assets must be regular files.');
    }
    const bytes = await readFile(path);
    files.push({
      ...FileDigestSchema.parse({
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
      path,
    });
  }
  if (platform === ReleasePlatform.MACOS) {
    for (const architecture of architectures) {
      const inventory = z
        .object({
          version: z.literal(version),
          architecture: z.literal(architecture),
          status: z.literal('verified'),
          artifacts: z.array(FileDigestSchema).length(2),
        })
        .parse(await readReleaseJson(join(directory, `MacSignatures-${architecture}.json`)));
      for (const format of ['dmg', 'zip']) {
        const name = `Tro-${version}-macos-${architecture}.${format}`;
        const matches = inventory.artifacts.filter((artifact) => artifact.name === name);
        const file = files.find((candidate) => candidate.name === name);
        if (
          matches.length !== 1 ||
          matches[0]?.sha256 !== file?.sha256 ||
          matches[0]?.size !== file?.size
        ) {
          throw new Error('macOS release bytes differ from the verified signature inventory.');
        }
      }
    }
  } else {
    const inventory = z
      .array(
        z.object({
          path: z.string(),
          sha256: z.string(),
          status: z.string(),
          timestamped: z.boolean(),
        }),
      )
      .parse(await readReleaseJson(join(directory, 'WindowsSignatures.json')));
    const name = `Tro-${version}-windows-x64-setup.exe`;
    const matches = inventory.filter((record) => record.path === name);
    if (
      matches.length !== 1 ||
      matches[0]?.status !== 'Valid' ||
      !matches[0].timestamped ||
      matches[0].sha256 !== files.find((file) => file.name === name)?.sha256
    ) {
      throw new Error('Windows installer differs from the verified signature inventory.');
    }
  }
  return files;
}

/** Retry only artifacts from this run/version/commit; keep each target's newest successful upload. */
async function readDesktopReleaseFiles(
  directory: string,
  version: string,
  settings: ReturnType<typeof readReleasePublishingEnv>,
): Promise<ReleaseFile[]> {
  const names = await readdir(directory);
  const files: ReleaseFile[] = [];
  const selectedNames: string[] = [];
  for (const target of Object.values(ReleaseTarget)) {
    const prefix = `Tro-${version}-${target}-${settings.commit}-${settings.runId}-`;
    const candidates = names.filter((name) => name.startsWith(prefix));
    let selected: { name: string; attempt: bigint } | undefined;
    for (const name of candidates) {
      const suffix = name.slice(prefix.length);
      if (!/^[1-9][0-9]{0,19}$/.test(suffix)) {
        throw new Error('Release artifact attempt is invalid.');
      }
      const attempt = BigInt(suffix);
      if (attempt > BigInt(settings.attempt)) {
        throw new Error('Release artifact comes from a future attempt.');
      }
      if (!selected || attempt > selected.attempt) {
        selected = { name, attempt };
      }
    }
    if (!selected) {
      throw new Error('A required desktop target has no verified artifacts.');
    }
    selectedNames.push(...candidates);
    const path = join(directory, selected.name);
    if (!(await lstat(path)).isDirectory()) {
      throw new Error('Release artifact must be a regular directory.');
    }
    const architecture = target === ReleaseTarget.MACOS_ARM64 ? 'arm64' : 'x64';
    files.push(
      ...(await readReleaseFiles(
        path,
        target === ReleaseTarget.WINDOWS_X64 ? ReleasePlatform.WINDOWS : ReleasePlatform.MACOS,
        version,
        target === ReleaseTarget.WINDOWS_X64 ? undefined : architecture,
      )),
    );
  }
  if (names.length !== selectedNames.length) {
    throw new Error('Unexpected release artifacts were downloaded.');
  }
  return files;
}

/** Publish one complete desktop release after all three targets and remote asset hashes pass. */
export async function publishDesktopRelease(
  directory: string,
  packagePath: string,
  environment: NodeJS.ProcessEnv,
  run: ReleaseCommand = runReleaseCommand,
  options: ReleasePublishOptions = {},
): Promise<string> {
  const settings = readReleasePublishingEnv(environment);
  const { version } = z
    .object({ version: DesktopReleaseVersionSchema })
    .parse(await readReleaseJson(packagePath));
  const stage = (name: string): void => {
    console.info(JSON.stringify({ event: 'release.publish.stage', stage: name }));
  };
  stage('verify-files');
  const files = await readDesktopReleaseFiles(resolve(directory), version, settings);
  const tag = `release-v${version}-${settings.commit.slice(0, 12)}-${settings.runId}-${settings.attempt}`;
  const repositoryArguments = ['--repo', `github.com/${settings.repository}`];
  if (!options.resume) {
    stage('create-draft');
    await run([
      'release',
      'create',
      tag,
      ...repositoryArguments,
      '--draft',
      '--target',
      settings.commit,
      '--latest=false',
      '--title',
      `Tro ${version}`,
      '--notes',
      `Signed macOS (Apple Silicon and Intel) and Windows x64 installers from commit ${settings.commit}.\n\nBuild: https://github.com/${settings.repository}/actions/runs/${settings.runId}/attempts/${settings.attempt}`,
    ]);
    stage('upload-assets');
    await run([
      'release',
      'upload',
      tag,
      ...repositoryArguments,
      ...files.map((file) => file.path),
    ]);
  }
  /* GitHub's REST tag endpoint only resolves published releases; gh can resolve drafts. */
  stage('resolve-draft');
  const identity: unknown = JSON.parse(
    await run(['release', 'view', tag, ...repositoryArguments, '--json', 'databaseId']),
  );
  const { databaseId } = z.object({ databaseId: z.number().int().positive() }).parse(identity);
  stage('verify-upload');
  const raw: unknown = JSON.parse(
    await run([
      'api',
      `repos/${settings.repository}/releases/${String(databaseId)}`,
      '--hostname',
      'github.com',
    ]),
  );
  const result = z
    .object({
      draft: z.literal(true),
      tag_name: z.literal(tag),
      target_commitish: z.literal(settings.commit),
      assets: z.array(
        z.object({
          name: z.string(),
          size: z.number(),
          digest: z.string(),
          state: z.literal('uploaded'),
        }),
      ),
    })
    .safeParse(raw);
  if (!result.success) {
    console.error(JSON.stringify({ event: 'release.publish.upload.rejected', reason: 'metadata' }));
    throw new Error('Uploaded release metadata is invalid. Draft was not published.');
  }
  const uploaded = result.data;
  if (
    uploaded.assets.length !== files.length ||
    files.some((file) => {
      const matches = uploaded.assets.filter((asset) => asset.name === file.name);
      return (
        matches.length !== 1 ||
        matches[0]?.size !== file.size ||
        matches[0].digest !== `sha256:${file.sha256}`
      );
    })
  ) {
    console.error(
      JSON.stringify({
        event: 'release.publish.upload.rejected',
        reason: 'assets',
        expectedFileCount: files.length,
        uploadedAssetCount: uploaded.assets.length,
      }),
    );
    throw new Error(
      'Uploaded release assets differ from the verified local files. Draft was not published.',
    );
  }
  stage('publish');
  await run(['release', 'edit', tag, ...repositoryArguments, '--draft=false', '--latest=false']);
  const url = `https://github.com/${settings.repository}/releases/tag/${tag}`;
  console.info(JSON.stringify({ event: 'release.publish.completed', tag, url }));
  return url;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { directory: { type: 'string' }, resume: { type: 'boolean', default: false } },
    });
    await publishDesktopRelease(
      z.string().parse(values.directory),
      resolve('package.json'),
      process.env,
      runReleaseCommand,
      { resume: values.resume },
    );
  } catch {
    console.error(JSON.stringify({ event: 'release.publish.failed' }));
    console.error(
      'Release publishing failed. Inspect the last safe stage; any incomplete release stays a draft.',
    );
    process.exitCode = 1;
  }
}
