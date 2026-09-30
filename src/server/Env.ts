import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { AppEnvironment, AppEnvironmentSchema } from '#contracts/AppEnvironment.js';

export interface ServerEnv {
  APP_ENV: AppEnvironment;
  DATABASE_URL: string;
  HOST: string;
  PORT: number;
}

/** Startup owns loading .env; this module only validates supplied values. */
export function readServerEnv(environment: NodeJS.ProcessEnv): ServerEnv {
  return createEnv({
    server: {
      APP_ENV: AppEnvironmentSchema.default(AppEnvironment.DEV),
      DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Backend configuration is invalid.');
    },
  });
}
