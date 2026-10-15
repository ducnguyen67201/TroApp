import { appendFile } from 'node:fs/promises';
import { readReleasePreparationEnv } from './Env.js';
import {
  prepareDesktopRelease,
  ReleasePreparationError,
  ReleasePreparationFailure,
  type ReleasePreparationStage,
} from './ReleaseVersion.js';

let stage: ReleasePreparationStage | undefined;

try {
  const environment = readReleasePreparationEnv(process.env);
  const release = await prepareDesktopRelease({
    workspace: process.cwd(),
    sourceCommit: environment.sourceCommit,
    runId: environment.runId,
    recordStage: (nextStage) => {
      stage = nextStage;
      console.log(JSON.stringify({ event: 'release.version.stage', stage }));
    },
  });
  await appendFile(
    environment.outputPath,
    `version=${release.version}\ncommit=${release.commit}\ntag=${release.tag}\n`,
  );
  console.log(JSON.stringify({ event: 'release.version.prepared', ...release }));
} catch (error) {
  const fallbackReason = stage
    ? ReleasePreparationFailure.UNEXPECTED
    : ReleasePreparationFailure.CONFIGURATION;
  console.error(
    JSON.stringify({
      event: 'release.version.failed',
      stage: stage ?? 'configuration',
      reason: error instanceof ReleasePreparationError ? error.reason : fallbackReason,
    }),
  );
  process.exitCode = 1;
}
