import { readReleaseBuildEnv } from './Env.js';
import { applyDesktopReleaseVersion } from './ReleaseVersion.js';

try {
  const environment = readReleaseBuildEnv(process.env);
  await applyDesktopReleaseVersion(process.cwd(), environment.version);
  console.log(JSON.stringify({ event: 'release.version.applied', version: environment.version }));
} catch {
  console.error(JSON.stringify({ event: 'release.version.failed', stage: 'build_version' }));
  process.exitCode = 1;
}
