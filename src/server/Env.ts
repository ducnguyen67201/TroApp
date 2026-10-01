import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { AppEnvironment, AppEnvironmentSchema } from '#contracts/AppEnvironment.js';

export interface ServerEnv {
  APP_ENV: AppEnvironment;
  DATABASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  HOST: string;
  PORT: number;
}

function isAllowedGoogleRedirect(value: string): boolean {
  const url = new URL(value);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/api/v1/auth/google/callback' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal))
  );
}

/** Startup owns loading .env; this module only validates supplied values. */
export function readServerEnv(environment: NodeJS.ProcessEnv): ServerEnv {
  return createEnv({
    server: {
      APP_ENV: AppEnvironmentSchema.default(AppEnvironment.DEV),
      DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
      GOOGLE_CLIENT_ID: z.string().min(10),
      GOOGLE_CLIENT_SECRET: z.string().min(10),
      GOOGLE_REDIRECT_URI: z.url().refine(isAllowedGoogleRedirect),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Backend configuration is invalid.');
    },
  });
}
