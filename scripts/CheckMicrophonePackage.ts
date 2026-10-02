import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const runFile = promisify(execFile);
const require = createRequire(import.meta.url);
const electronPath = z.string().parse(require('electron'));
const packagePath = process.argv[2];
if (!packagePath) {
  throw new Error('Supply a macOS .app or Windows unpacked directory.');
}
const isMacPackage = packagePath.endsWith('.app');
const root = resolve(packagePath);
const archivePath = isMacPackage
  ? join(root, 'Contents', 'Resources', 'app.asar')
  : join(root, 'resources', 'app.asar');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tro-microphone-package-check-'));

/* Electron's filesystem understands ASAR. This read-only runner checks the actual
   archive without extracting it or booting Tro's auth, driver, or model workers. */
const inspectArchive = `
const { app } = require('electron');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const archive = process.argv[2];
try {
  const main = readFileSync(join(archive, 'main', 'Main.js'), 'utf8');
  const preload = readFileSync(join(archive, 'preload', 'Preload.cjs'), 'utf8');
  const assets = readdirSync(join(archive, 'renderer', 'assets'));
  const processor = assets.find(name => name.startsWith('MicrophoneTestProcessor-') && name.endsWith('.js'));
  const voiceProcessor = assets.find(name => name.startsWith('VoiceAudioProcessor-') && name.endsWith('.js'));
  if (!processor || !voiceProcessor || !main.includes('tro:microphone-test') || !preload.includes('controlMicrophoneTest') || !preload.includes('subscribeMicrophoneTest')) {
    throw new Error('Microphone assets or bridge operations missing');
  }
  const code = readFileSync(join(archive, 'renderer', 'assets', processor), 'utf8');
  if (!code.includes('tro-microphone-test')) { throw new Error('Test processor missing'); }
  console.log(JSON.stringify({ archive: 'passed', testProcessor: processor, voiceProcessor }));
  app.exit(0);
} catch {
  console.error('Packaged microphone assets could not be verified.');
  app.exit(1);
}
`;

try {
  const runnerPath = join(temporaryDirectory, 'Inspect.cjs');
  await writeFile(runnerPath, inspectArchive);
  const { stdout } = await runFile(electronPath, [runnerPath, archivePath], { timeout: 30_000 });
  const raw: unknown = JSON.parse(stdout.trim());
  const archive = z
    .strictObject({
      archive: z.literal('passed'),
      testProcessor: z.string(),
      voiceProcessor: z.string(),
    })
    .parse(raw);
  let microphoneMetadata = 'requires Windows hardware verification';
  let signing = 'not checked';
  if (isMacPackage && process.platform === 'darwin') {
    const { stdout: description } = await runFile('/usr/bin/plutil', [
      '-extract',
      'NSMicrophoneUsageDescription',
      'raw',
      '-o',
      '-',
      join(root, 'Contents', 'Info.plist'),
    ]);
    if (!description.includes('local sound tests')) {
      throw new Error('Packaged microphone purpose does not describe local tests.');
    }
    const { stdout: entitlements } = await runFile('/usr/bin/codesign', [
      '-d',
      '--entitlements',
      '-',
      '--xml',
      root,
    ]);
    if (!/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/.test(entitlements)) {
      throw new Error('Packaged audio-input entitlement is missing.');
    }
    microphoneMetadata = 'passed';
    const { stderr: signature } = await runFile('/usr/bin/codesign', ['-dv', root]);
    signing = signature.includes('Signature=adhoc')
      ? 'ad hoc; release signing unverified'
      : 'signature present; trust and notarization unverified';
  }
  console.log(
    JSON.stringify(
      {
        ...archive,
        microphoneMetadata,
        signing,
        hardware: 'not exercised; use docs/MicrophoneHardwareChecks.md',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
