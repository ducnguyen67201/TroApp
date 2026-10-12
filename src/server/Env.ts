import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { AppEnvironment, AppEnvironmentSchema } from '#contracts/AppEnvironment.js';

export interface ServerEnv {
  APP_ENV: AppEnvironment;
  DATABASE_URL: string;
  HOST: string;
  PORT: number;
  AUTH_SECRET: string;
  AUTH_BASE_URL: string;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
}

/** Startup owns loading .env; this module only validates supplied values. */
export function readServerEnv(environment: NodeJS.ProcessEnv): ServerEnv {
  const validated = createEnv({
    server: {
      APP_ENV: AppEnvironmentSchema.default(AppEnvironment.DEV),
      DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      AUTH_SECRET: z.string().min(32),
      AUTH_BASE_URL: z.url().default('http://127.0.0.1:3000'),
      GOOGLE_CLIENT_ID: z.string().min(1).optional(),
      GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
      OPENAI_API_KEY: z.string().min(20).optional(),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Backend configuration is invalid.');
    },
  });

  if (
    validated.APP_ENV !== AppEnvironment.DEV &&
    (!environment['AUTH_BASE_URL'] || !validated.AUTH_BASE_URL.startsWith('https://'))
  ) {
    throw new Error('Hosted authentication requires a public HTTPS AUTH_BASE_URL.');
  }

  if (validated.AUTH_SECRET.startsWith('replace-with-')) {
    throw new Error('Replace the example AUTH_SECRET before starting the backend.');
  }

  if (Boolean(validated.GOOGLE_CLIENT_ID) !== Boolean(validated.GOOGLE_CLIENT_SECRET)) {
    throw new Error('Google sign-in needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }

  return validated;
}
