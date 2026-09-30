import { z } from 'zod';

export const AppEnvironment = {
  DEV: 'dev',
  STAGE: 'stage',
  PROD: 'prod',
} as const;

export const AppEnvironmentSchema = z.enum(AppEnvironment);

export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;
