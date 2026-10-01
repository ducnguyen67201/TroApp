import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const driverVersion = '0.30.4';
const releaseBaseUrl = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${driverVersion}`;

interface DriverRelease {
  archiveName: string;
  sha256: string;
  archiveRoot: string;
}

const driverReleases = {
  darwin: {
    archiveName: `cua-driver-rs-${driverVersion}-darwin-universal.tar.gz`,
    sha256: '9c75a186f89352fb522dc67791575f8c9e8081a38795af2706e103d41fa72be4',
    archiveRoot: `cua-driver-rs-${driverVersion}-darwin-universal`,
  },
  win32_x64: {
    archiveName: `cua-driver-rs-${driverVersion}-windows-x86_64.zip`,
    sha256: '71ca8dfb3b98edd1e897ec59715269c40610879e03aeff6ae0e2ce709c6900c9',
    archiveRoot: `cua-driver-rs-${driverVersion}-windows-x86_64`,
  },
  win32_arm64: {
    archiveName: `cua-driver-rs-${driverVersion}-windows-arm64.zip`,
    sha256: '225926273a0bf962da7cefdd6915144d41f6ff519fa270f6c57c85436ae860ae',
    archiveRoot: `cua-driver-rs-${driverVersion}-windows-arm64`,
  },
} satisfies Record<string, DriverRelease>;

function selectDriverRelease(platform: NodeJS.Platform, architecture: string): DriverRelease {
  if (platform === 'darwin') {
    return driverReleases.darwin;
  }
  if (platform === 'win32' && architecture === 'x64') {
    return driverReleases.win32_x64;
  }
  if (platform === 'win32' && architecture === 'arm64') {
    return driverReleases.win32_arm64;
  }
  throw new Error(`Cua Driver packaging is unsupported on ${platform}/${architecture}.`);
}

async function hasPreparedDriver(destination: string, platform: NodeJS.Platform): Promise<boolean> {
  const executable =
    platform === 'darwin'
      ? join(destination, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver')
      : join(destination, 'cua-driver.exe');
  try {
    const version = await readFile(join(destination, 'DriverVersion.txt'), 'utf8');
    await access(executable);
    return version.trim() === driverVersion;
  } catch {
    return false;
  }
}

/** Downloads a pinned, checksum-verified Driver into a Tro-owned directory.
 * The desktop installer carries this directory, so users never need a CLI
 * installer or a first-launch network download. Development caches it once. */
export async function prepareCuaDriver(destination: string): Promise<void> {
  if (await hasPreparedDriver(destination, process.platform)) {
    return;
  }

  const release = selectDriverRelease(process.platform, process.arch);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tro-cua-driver-'));
  try {
    const response = await fetch(`${releaseBaseUrl}/${release.archiveName}`);
    if (!response.ok) {
      throw new Error(`Could not download Cua Driver (${String(response.status)}).`);
    }
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== release.sha256) {
      throw new Error('Cua Driver download failed its pinned SHA-256 check.');
    }

    const archivePath = join(temporaryDirectory, release.archiveName);
    await writeFile(archivePath, archive);
    await runFile('tar', ['-xf', archivePath, '-C', temporaryDirectory]);
    const extractedDirectory = join(temporaryDirectory, release.archiveRoot);

    /* Replace only Tro's own cache/staging path after verification and
       extraction. Never alter an independently installed Cua Driver. */
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    if (process.platform === 'darwin') {
      await cp(join(extractedDirectory, 'CuaDriver.app'), join(destination, 'CuaDriver.app'), {
        recursive: true,
        preserveTimestamps: true,
      });
      await cp(join(extractedDirectory, 'LICENSE'), join(destination, 'LICENSE'));
    } else {
      await cp(extractedDirectory, destination, { recursive: true, force: true });
    }
    await writeFile(join(destination, 'DriverVersion.txt'), `${driverVersion}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv.includes('--development')) {
  const destination = join(homedir(), '.cache', 'tro', 'cua-driver');
  await prepareCuaDriver(destination);
}
