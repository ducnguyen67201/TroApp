import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const DopplerNamePattern = /^[a-zA-Z0-9_-]+$/;
const DevelopmentConfigPattern = /^dev(?:[_-].+)?$/;

export interface DevelopmentEnv {
  TRO_DOPPLER_PROJECT: string;
  TRO_DOPPLER_CONFIG: string;
}

/** Validates public bootstrap metadata without reading or exposing resolved secrets. */
export function readDevelopmentEnv(environment: NodeJS.ProcessEnv): DevelopmentEnv {
  return createEnv({
    server: {
      TRO_DOPPLER_PROJECT: z.string().regex(DopplerNamePattern).default('tro'),
      TRO_DOPPLER_CONFIG: z
        .string()
        .regex(DopplerNamePattern)
        .regex(DevelopmentConfigPattern)
        .default('dev_local'),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error(
        'Development bootstrap configuration is invalid. Use a Doppler project slug and a config named dev, dev_*, or dev-*.',
      );
    },
  });
}
