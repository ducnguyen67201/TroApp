import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CuaCompanionBuildSchema } from '../src/contracts/CuaCompanionBuild.js';
import { MacNotarizationMethod, readMacSigningEnv } from './Env.js';
import {
  readMacFileDigest,
  readMacNativeFiles,
  runMacCommand,
  verifyMacApp,
  type MacCommand,
  type MacReleaseSettings,
} from './MacSigning.js';

const NotaryStatus = {
  ACCEPTED: 'Accepted',
  INVALID: 'Invalid',
  REJECTED: 'Rejected',
  PENDING: 'In Progress',
} as const;
const NotarySubmissionSchema = z.object({ id: z.uuid() });
const NotaryResponseSchema = NotarySubmissionSchema.extend({ status: z.enum(NotaryStatus) });
const ReleaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

interface NotaryPorts {
  run: MacCommand;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

/** Submit once, log the safe submission ID, and poll that same submission to a deadline. */
export async function notarizeMacDmg(
  path: string,
  settings: MacReleaseSettings,
  ports: NotaryPorts = { run: runMacCommand, now: Date.now, wait: delay },
): Promise<string> {
  /* Profile credentials remain in the temporary keychain; polling and rejection logs
   * must use the same authentication method as the initial submission. */
  const auth =
    settings.notarizationMethod === MacNotarizationMethod.KEYCHAIN_PROFILE
      ? ['--keychain-profile', settings.keychainProfile, '--keychain', settings.keychain]
      : ['--key', settings.apiKey, '--key-id', settings.apiKeyId, '--issuer', settings.apiIssuer];
  const submitted = await ports.run('/usr/bin/xcrun', [
    'notarytool',
    'submit',
    path,
    ...auth,
    '--output-format',
    'json',
  ]);
  const raw: unknown = JSON.parse(submitted.stdout);
  const { id } = NotarySubmissionSchema.parse(raw);
  console.info(JSON.stringify({ event: 'mac.release.notary.submitted', submissionId: id }));
  const deadline = ports.now() + 30 * 60 * 1000;
  for (let attempt = 0; attempt < 120 && ports.now() < deadline; attempt += 1) {
    const result = await ports.run('/usr/bin/xcrun', [
      'notarytool',
      'info',
      id,
      ...auth,
      '--output-format',
      'json',
    ]);
    const value: unknown = JSON.parse(result.stdout);
    const response = NotaryResponseSchema.parse(value);
    if (response.id !== id) {
      throw new Error('Apple returned an unrelated notarization result.');
    }
    if (response.status === NotaryStatus.ACCEPTED) {
      await ports.run('/usr/bin/xcrun', ['stapler', 'staple', path]);
      await ports.run('/usr/bin/xcrun', ['stapler', 'validate', path]);
      return id;
    }
    if (response.status !== NotaryStatus.PENDING) {
      // Apple logs may contain local paths and arbitrary diagnostic text. Count issues only.
      const log = await ports.run('/usr/bin/xcrun', ['notarytool', 'log', id, ...auth]);
      const logValue: unknown = JSON.parse(log.stdout);
      const issues = z
        .object({ issues: z.array(z.unknown()).nullable().optional() })
        .parse(logValue);
      console.error(
        JSON.stringify({
          event: 'mac.release.notary.rejected',
          submissionId: id,
          issueCount: issues.issues?.length ?? 0,
        }),
      );
      throw new Error('Apple rejected the macOS release. Inspect the submission log privately.');
    }
    await ports.wait(15_000);
  }
  throw new Error('macOS notarization deadline exceeded. Recheck the recorded submission ID.');
}

/** Require one exact candidate per format; never promote stale files from another build. */
export function selectMacArtifacts(
  names: readonly string[],
  version: string,
  architecture: 'arm64' | 'x64',
): { dmg: string; zip: string } {
  ReleaseVersionSchema.parse(version);
  const stem = `Tro-${version}-macos-${architecture}`;
  const dmg = `${stem}.dmg`;
  const zip = `${stem}.zip`;
  const candidates = names.filter((name) => /\.(dmg|zip|yml|yaml)$/i.test(name));
  if (candidates.length !== 2 || !candidates.includes(dmg) || !candidates.includes(zip)) {
    throw new Error(
      'macOS release artifacts are missing, ambiguous or contain unsupported update metadata.',
    );
  }
  return { dmg, zip };
}

async function verifyAppVersion(app: string, version: string, run: MacCommand): Promise<void> {
  const result = await run('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    join(app, 'Contents', 'Info.plist'),
  ]);
  if (result.stdout.trim() !== version) {
    throw new Error('macOS archive contains an unexpected app version.');
  }
}

/** Verify the actual distributed app, both CPU slices and its claimed macOS 13 minimum. */
async function inventoryMacApp(
  app: string,
  settings: MacReleaseSettings,
  version: string,
  run: MacCommand,
) {
  await verifyMacApp(app, settings, run);
  await verifyAppVersion(app, version, run);
  const appRoot = await realpath(app);
  const files = [];
  for (const path of await readMacNativeFiles(app)) {
    const commands = await run('/usr/bin/otool', ['-l', path]);
    const minimumVersions = [
      ...commands.stdout.matchAll(
        /(?:cmd LC_BUILD_VERSION[\s\S]*?\bminos|cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion)\s+(\d+\.\d+(?:\.\d+)?)/g,
      ),
    ].map((match) => match[1]);
    if (
      minimumVersions.length === 0 ||
      minimumVersions.some(
        (value) =>
          !value ||
          Number(value.split('.')[0]) > 13 ||
          (Number(value.split('.')[0]) === 13 && Number(value.split('.')[1]) > 0),
      )
    ) {
      throw new Error(
        'macOS native minimum version exceeds the advertised macOS 13.0 requirement or is unknown.',
      );
    }
    files.push({
      path: relative(appRoot, path),
      ...(await readMacFileDigest(path)),
      minimumVersions,
    });
  }
  const raw: unknown = JSON.parse(
    await readFile(join(app, 'Contents', 'Resources', 'cua-driver', 'CompanionBuild.json'), 'utf8'),
  );
  const provenance = CuaCompanionBuildSchema.parse(raw);
  if (provenance.architecture !== settings.architecture) {
    throw new Error('macOS companion provenance has the wrong architecture.');
  }
  const patch = await readMacFileDigest(
    fileURLToPath(new URL('../driver-patches/CursorCompanion.patch', import.meta.url)),
  );
  if (provenance.patchSha256 !== patch.sha256) {
    throw new Error('macOS companion provenance does not match the release patch.');
  }
  return {
    files,
    appArchive: await readMacFileDigest(join(app, 'Contents', 'Resources', 'app.asar')),
    preSigningCompanion: provenance,
  };
}

/** No changes to app contents after sealing; only staple the container before final hashing. */
export async function verifyMacRelease(
  directory: string,
  settings: MacReleaseSettings,
  version: string,
  run: MacCommand = runMacCommand,
  notarize: (path: string, settings: MacReleaseSettings) => Promise<string> = notarizeMacDmg,
): Promise<void> {
  const root = resolve(directory);
  const inventoryPath = join(root, `MacSignatures-${settings.architecture}.json`);
  // A failed re-verification must not leave an old success inventory available for upload.
  await rm(inventoryPath, { force: true });
  const artifacts = selectMacArtifacts(await readdir(root), version, settings.architecture);
  const dmg = join(root, artifacts.dmg);
  const zip = join(root, artifacts.zip);
  for (const path of [dmg, zip]) {
    if ((await readMacFileDigest(path)).size === 0) {
      throw new Error('macOS release artifact is empty.');
    }
  }
  const temporary = await mkdtemp(join(tmpdir(), 'tro-mac-verification-'));
  try {
    const extracted = join(temporary, 'zip');
    await mkdir(extracted);
    console.info(
      JSON.stringify({
        event: 'mac.release.stage',
        stage: 'verify-zip',
        architecture: settings.architecture,
      }),
    );
    await run('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
    const zipInventory = await inventoryMacApp(join(extracted, 'Tro.app'), settings, version, run);
    console.info(
      JSON.stringify({
        event: 'mac.release.stage',
        stage: 'notarize-dmg',
        architecture: settings.architecture,
      }),
    );
    const submissionId = await notarize(dmg, settings);
    await run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    await run('/usr/sbin/spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=4',
      dmg,
    ]);
    const mount = join(temporary, 'mount');
    await mkdir(mount);
    let mounted = false;
    let dmgInventory;
    try {
      console.info(
        JSON.stringify({
          event: 'mac.release.stage',
          stage: 'verify-dmg',
          architecture: settings.architecture,
        }),
      );
      await run('/usr/bin/hdiutil', [
        'attach',
        dmg,
        '-readonly',
        '-nobrowse',
        '-mountpoint',
        mount,
      ]);
      mounted = true;
      dmgInventory = await inventoryMacApp(join(mount, 'Tro.app'), settings, version, run);
      if (JSON.stringify(dmgInventory) !== JSON.stringify(zipInventory)) {
        throw new Error('macOS DMG and ZIP contain different native app content.');
      }
    } finally {
      if (mounted) {
        await run('/usr/bin/hdiutil', ['detach', mount]);
      }
    }
    const inventory = {
      version,
      architecture: settings.architecture,
      teamId: settings.teamId,
      status: 'verified',
      timestamped: true,
      hardenedRuntime: true,
      notarizationSubmissionId: submissionId,
      ...dmgInventory,
      artifacts: await Promise.all(
        [dmg, zip].map(async (path) => ({
          name: basename(path),
          ...(await readMacFileDigest(path)),
        })),
      ),
    };
    await writeFile(inventoryPath, JSON.stringify(inventory, null, 2) + '\n');
    console.info(
      JSON.stringify({
        event: 'mac.release.verified',
        architecture: settings.architecture,
        version,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { directory: { type: 'string' }, arch: { type: 'string' } },
    });
    const settings = readMacSigningEnv(process.env, process.platform, process.arch);
    if (!settings.enabled || !values.directory || values.arch !== settings.architecture) {
      throw new Error('macOS release verifier requires enabled signing and matching architecture.');
    }
    const raw: unknown = JSON.parse(await readFile('package.json', 'utf8'));
    const { version } = z.object({ version: ReleaseVersionSchema }).parse(raw);
    await verifyMacRelease(values.directory, settings, version);
  } catch {
    console.error(
      'macOS release verification failed. Inspect the last safe stage or submission ID.',
    );
    process.exitCode = 1;
  }
}
