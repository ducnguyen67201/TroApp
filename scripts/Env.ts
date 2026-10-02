import { createEnv } from '@t3-oss/env-core';
import { loadEnv } from 'vite';
import { AppUpdateUrlSchema } from '../src/contracts/AppUpdate.js';

/** Packaging reads only the public release address; credentials never enter it. */
export function readDesktopReleaseEnv(
  environment: NodeJS.ProcessEnv,
  fileEnvironment: Readonly<Record<string, string>> = {},
): {
  updateFeedUrl: string | undefined;
} {
  const validated = createEnv({
    server: { MAIN_VITE_UPDATE_FEED_URL: AppUpdateUrlSchema.optional() },
    runtimeEnv: {
      MAIN_VITE_UPDATE_FEED_URL:
        environment['MAIN_VITE_UPDATE_FEED_URL'] ?? fileEnvironment['MAIN_VITE_UPDATE_FEED_URL'],
    },
    emptyStringAsUndefined: true,
    onValidationError: () => {
      throw new Error('Desktop release configuration is invalid.');
    },
  });
  return { updateFeedUrl: validated.MAIN_VITE_UPDATE_FEED_URL };
}

/** Match electron-vite's production env files before validating public settings. */
export function loadDesktopReleaseEnv(): ReturnType<typeof readDesktopReleaseEnv> {
  return readDesktopReleaseEnv(process.env, loadEnv('production', process.cwd(), 'MAIN_VITE_'));
}
