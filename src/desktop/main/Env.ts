import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { AppEnvironment, AppEnvironmentSchema } from '#contracts/AppEnvironment.js';
import { AppUpdateUrlSchema } from '#contracts/AppUpdate.js';

export interface DesktopEnvSource {
  environment: NodeJS.ProcessEnv;
  bundledApiUrl: unknown;
  bundledAppEnvironment: unknown;
  bundledUpdateUrl?: unknown;
  isPackaged: boolean;
}

export interface DesktopEnv {
  API_BASE_URL: string;
  APP_ENV: AppEnvironment;
  RENDERER_URL: string | undefined;
  UPDATE_FEED_URL: string | undefined;
}

function isAllowedApiUrl(value: string): boolean {
  const url = new URL(value);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal))
  );
}

/** Only public desktop settings enter this process; backend secrets are never imported. */
export function readDesktopEnv({
  environment,
  bundledApiUrl,
  bundledAppEnvironment,
  bundledUpdateUrl,
  isPackaged,
}: DesktopEnvSource): DesktopEnv {
  const apiBaseUrl = bundledApiUrl ?? 'http://127.0.0.1:3000';
  const appEnvironment =
    bundledAppEnvironment ?? (isPackaged ? AppEnvironment.PROD : AppEnvironment.DEV);

  if (
    typeof apiBaseUrl !== 'string' ||
    typeof appEnvironment !== 'string' ||
    (bundledUpdateUrl !== undefined && typeof bundledUpdateUrl !== 'string')
  ) {
    throw new Error('Desktop configuration is invalid.');
  }

  /* electron-vite supplies the renderer URL during development. It is not a
     second user-configured API address. */
  const validated = createEnv({
    server: {
      API_BASE_URL: z.url().refine(isAllowedApiUrl),
      APP_ENV: AppEnvironmentSchema,
      RENDERER_URL: z.url().optional(),
      UPDATE_FEED_URL: AppUpdateUrlSchema.optional(),
    },
    runtimeEnv: {
      API_BASE_URL: apiBaseUrl,
      APP_ENV: appEnvironment,
      RENDERER_URL: environment['ELECTRON_RENDERER_URL'],
      UPDATE_FEED_URL: bundledUpdateUrl,
    },
    onValidationError: () => {
      throw new Error('Desktop configuration is invalid.');
    },
  });

  return {
    API_BASE_URL: validated.API_BASE_URL,
    APP_ENV: validated.APP_ENV,
    RENDERER_URL: validated.RENDERER_URL,
    UPDATE_FEED_URL: validated.UPDATE_FEED_URL,
  };
}
