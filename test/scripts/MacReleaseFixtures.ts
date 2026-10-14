import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CuaCompanionBuild } from '../../src/contracts/CuaCompanionBuild.js';
import type { MacCommand, MacReleaseSettings } from '../../scripts/MacSigning.js';
import { MacNotarizationMethod } from '../../scripts/Env.js';

export const macSettings = {
  enabled: true,
  architecture: 'arm64',
  identity: 'A'.repeat(40),
  teamId: 'TESTTEAM12',
  keychain: '/temporary/signing.keychain-db',
  notarizationMethod: MacNotarizationMethod.API_KEY,
  apiKey: '/temporary/AuthKey.p8',
  apiKeyId: 'KEY1234567',
  apiIssuer: 'c74bf495-c6ee-4560-a2ef-c9a81218af12',
} satisfies MacReleaseSettings;

export const macProfileSettings = {
  enabled: true,
  architecture: 'arm64',
  identity: macSettings.identity,
  teamId: macSettings.teamId,
  keychain: macSettings.keychain,
  notarizationMethod: MacNotarizationMethod.KEYCHAIN_PROFILE,
  keychainProfile: 'tro-ci-notary',
} satisfies MacReleaseSettings;

export const macSignature =
  'Authority=Developer ID Application: Example (TESTTEAM12)\nTeamIdentifier=TESTTEAM12\nTimestamp=Oct 13, 2026\nCodeDirectory v=20500 flags=0x10000(runtime)\n';

export const macCommand: MacCommand = (executable, arguments_) => {
  let stdout = '';
  let stderr = '';
  if (executable.endsWith('lipo')) {
    stdout = 'arm64 x86_64';
  }
  if (executable.endsWith('otool')) {
    stdout = 'cmd LC_BUILD_VERSION\ncmdsize 32\nplatform 1\nminos 13.0\nsdk 15.0';
  }
  if (executable.endsWith('codesign') && arguments_.includes('--display')) {
    stderr = macSignature;
  }
  if (arguments_.includes('--entitlements')) {
    stdout =
      '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>';
  }
  if (arguments_.includes('CFBundleIdentifier')) {
    stdout = 'app.tro.desktop';
  }
  if (arguments_.includes('CFBundleShortVersionString')) {
    stdout = '0.1.1';
  }
  return Promise.resolve({ stdout, stderr });
};

export async function createMacFixture(app: string): Promise<void> {
  const driver = join(app, 'Contents', 'Resources', 'cua-driver');
  await mkdir(driver, { recursive: true });
  await writeFile(join(driver, 'cua-driver'), Buffer.from('cffaedfe00000000', 'hex'));
  await writeFile(join(app, 'Contents', 'Resources', 'app.asar'), 'application-fixture');
  const patch = await readFile('driver-patches/CursorCompanion.patch');
  await writeFile(
    join(driver, 'CompanionBuild.json'),
    JSON.stringify({
      version: CuaCompanionBuild.VERSION,
      sourceCommit: CuaCompanionBuild.SOURCE_COMMIT,
      architecture: 'arm64',
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      executableSha256: 'b'.repeat(64),
    }),
  );
}
