import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const runFile = promisify(execFile);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const RunIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
const VersionPartsSchema = z.tuple([
  z.number().int().min(0).max(65535),
  z.number().int().min(0).max(65535),
  z.number().int().min(0).max(65535),
]);

export const DesktopReleaseVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine((version) => VersionPartsSchema.safeParse(version.split('.').map(Number)).success);

const PackageSchema = z.looseObject({ version: DesktopReleaseVersionSchema });
const TagRecordSchema = z.tuple([z.string(), z.literal('tag'), CommitSchema, z.string()]);
const ReleaseTagPrefix = 'desktop-v';
const ReleaseRunTrailer = 'Tro-Release-Run: ';
const ReleaseSourceTrailer = 'Tro-Release-Source: ';
const TagRecordFormat = '%(refname:lstrip=2)%00%(objecttype)%00%(objectname)%00%(contents:body)%1e';

export const ReleasePreparationStage = {
  CHECK: 'check',
  REUSE: 'reuse',
  RESERVE: 'reserve',
  PUBLISH: 'publish',
} as const;

export type ReleasePreparationStage =
  (typeof ReleasePreparationStage)[keyof typeof ReleasePreparationStage];

export const ReleasePreparationFailure = {
  SOURCE_CHANGED: 'source_changed',
  DIRTY_WORKSPACE: 'dirty_workspace',
  INVALID_VERSION: 'invalid_version',
  INVALID_RESERVATION: 'invalid_reservation',
  GIT_OPERATION: 'git_operation',
  CONFIGURATION: 'configuration',
  UNEXPECTED: 'unexpected',
} as const;

export type ReleasePreparationFailure =
  (typeof ReleasePreparationFailure)[keyof typeof ReleasePreparationFailure];

/** Only these owned rejection reasons may enter release diagnostics. */
export class ReleasePreparationError extends Error {
  constructor(
    readonly reason: ReleasePreparationFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface PreparedDesktopRelease {
  version: string;
  commit: string;
  tag: string;
}

interface ReleaseReservation extends PreparedDesktopRelease {
  runId: string;
}

/** Increment the shared desktop patch version within Windows file-version limits. */
export function incrementPatchVersion(version: string): string {
  try {
    const parsed = DesktopReleaseVersionSchema.parse(version);
    const [major, minor, patch] = VersionPartsSchema.parse(parsed.split('.').map(Number));
    return DesktopReleaseVersionSchema.parse([major, minor, patch + 1].join('.'));
  } catch {
    throw new ReleasePreparationError(
      ReleasePreparationFailure.INVALID_VERSION,
      'Desktop release requires a supported major.minor.patch version.',
    );
  }
}

function readPackageVersion(contents: string): string {
  try {
    const value: unknown = JSON.parse(contents);
    return PackageSchema.parse(value).version;
  } catch {
    throw new ReleasePreparationError(
      ReleasePreparationFailure.INVALID_VERSION,
      'Desktop release package version is invalid.',
    );
  }
}

function compareVersions(first: string, second: string): number {
  const firstParts = VersionPartsSchema.parse(first.split('.').map(Number));
  const secondParts = VersionPartsSchema.parse(second.split('.').map(Number));
  for (const index of [0, 1, 2] as const) {
    const difference = firstParts[index] - secondParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function parseReservations(output: string): ReleaseReservation[] {
  try {
    return output
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [name, , , body] = TagRecordSchema.parse(record.split('\0'));
        const version = DesktopReleaseVersionSchema.parse(
          name.startsWith(ReleaseTagPrefix) ? name.slice(ReleaseTagPrefix.length) : name,
        );
        const lines = body.replaceAll('\r\n', '\n').split('\n');
        const runLines = lines.filter((line) => line.startsWith(ReleaseRunTrailer));
        const sourceLines = lines.filter((line) => line.startsWith(ReleaseSourceTrailer));
        if (runLines.length !== 1 || sourceLines.length !== 1) {
          throw new Error('Invalid reservation trailers.');
        }
        return {
          version,
          tag: ReleaseTagPrefix + version,
          runId: RunIdSchema.parse(runLines[0]?.slice(ReleaseRunTrailer.length)),
          commit: CommitSchema.parse(sourceLines[0]?.slice(ReleaseSourceTrailer.length)),
        };
      });
  } catch {
    throw new ReleasePreparationError(
      ReleasePreparationFailure.INVALID_RESERVATION,
      'Desktop release tag metadata is invalid.',
    );
  }
}

/** Apply the reserved app version only inside a disposable build checkout. */
export async function applyDesktopReleaseVersion(
  workspace: string,
  version: string,
): Promise<void> {
  const releaseVersion = DesktopReleaseVersionSchema.parse(version);
  const packagePath = join(workspace, 'package.json');
  const rawPackage: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
  PackageSchema.parse(rawPackage);
  const metadata = z.record(z.string(), z.unknown()).parse(rawPackage);
  await writeFile(
    packagePath,
    JSON.stringify({ ...metadata, version: releaseVersion }, null, 2) + '\n',
  );
}

/**
 * Reserve one immutable tag per workflow run without writing protected main.
 * The caller owns a disposable checkout and serializes release runs. Published
 * reservations use a separate fetched namespace so an unpublished local tag
 * cannot make a failed publication look successful on retry.
 */
export async function prepareDesktopRelease(options: {
  workspace: string;
  sourceCommit: string;
  runId: string;
  recordStage?: (stage: ReleasePreparationStage) => void;
}): Promise<PreparedDesktopRelease> {
  const sourceCommit = CommitSchema.parse(options.sourceCommit);
  const runId = RunIdSchema.parse(options.runId);

  async function runGit(gitArguments: string[]): Promise<string> {
    try {
      const result = await runFile('git', gitArguments, {
        cwd: options.workspace,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    } catch {
      /* Git errors can contain credential-bearing remote URLs. */
      throw new ReleasePreparationError(
        ReleasePreparationFailure.GIT_OPERATION,
        `Desktop release Git operation failed: ${gitArguments[0] ?? 'unknown'}.`,
      );
    }
  }

  async function assertReservationSource(
    reservation: ReleaseReservation,
    reference: string,
  ): Promise<void> {
    if (
      reservation.commit !== sourceCommit ||
      (await runGit(['rev-parse', `${reference}^{}`])) !== sourceCommit
    ) {
      throw new ReleasePreparationError(
        ReleasePreparationFailure.INVALID_RESERVATION,
        'Release reservation does not match the requested source.',
      );
    }
  }

  options.recordStage?.(ReleasePreparationStage.CHECK);
  await runGit(['fetch', 'origin', 'main']);
  await runGit(['fetch', 'origin', 'refs/tags/desktop-v*:refs/desktop-releases/*']);
  const reservations = parseReservations(
    await runGit(['for-each-ref', `--format=${TagRecordFormat}`, 'refs/desktop-releases/']),
  );
  const previous = reservations.filter((reservation) => reservation.runId === runId);
  if (previous.length > 1) {
    throw new ReleasePreparationError(
      ReleasePreparationFailure.INVALID_RESERVATION,
      'Multiple versions are reserved for this release run.',
    );
  }
  const existing = previous[0];
  if (existing) {
    await assertReservationSource(existing, `refs/desktop-releases/${existing.version}`);
    options.recordStage?.(ReleasePreparationStage.REUSE);
    return { version: existing.version, commit: existing.commit, tag: existing.tag };
  }

  if ((await runGit(['rev-parse', 'origin/main'])) !== sourceCommit) {
    throw new ReleasePreparationError(
      ReleasePreparationFailure.SOURCE_CHANGED,
      'Main changed before release preparation. Start a new release run.',
    );
  }
  if (await runGit(['status', '--porcelain'])) {
    throw new ReleasePreparationError(
      ReleasePreparationFailure.DIRTY_WORKSPACE,
      'Release preparation requires a clean checkout.',
    );
  }

  let latestVersion = readPackageVersion(await runGit(['show', `${sourceCommit}:package.json`]));
  for (const reservation of reservations) {
    if (compareVersions(reservation.version, latestVersion) > 0) {
      latestVersion = reservation.version;
    }
  }
  const version = incrementPatchVersion(latestVersion);
  const tag = ReleaseTagPrefix + version;
  options.recordStage?.(ReleasePreparationStage.RESERVE);
  if (await runGit(['tag', '--list', tag])) {
    const local = parseReservations(
      await runGit(['for-each-ref', `--format=${TagRecordFormat}`, `refs/tags/${tag}`]),
    );
    const reservation = local[0];
    if (local.length !== 1 || !reservation || reservation.runId !== runId) {
      throw new ReleasePreparationError(
        ReleasePreparationFailure.INVALID_RESERVATION,
        'Existing local tag belongs to another release.',
      );
    }
    await assertReservationSource(reservation, `refs/tags/${tag}`);
  } else {
    await runGit([
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag',
      '-a',
      '-m',
      `Desktop ${version}`,
      '-m',
      `${ReleaseRunTrailer}${runId}\n${ReleaseSourceTrailer}${sourceCommit}`,
      tag,
      sourceCommit,
    ]);
  }
  options.recordStage?.(ReleasePreparationStage.PUBLISH);
  await runGit(['push', 'origin', `refs/tags/${tag}`]);
  return { version, commit: sourceCommit, tag };
}
