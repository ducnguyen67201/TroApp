import { defaultMaterialGenerationPolicy } from './features/materials/application/MaterialGeneration.js';
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
  CLASSROOM_INSIGHT_COLLECTION_POLICY?: string | undefined;
  CLASSROOM_INSIGHT_RETENTION_DAYS?: number | undefined;
  GUIDED_LESSON_MODEL: string;
  GUIDED_LESSON_SPEECH_MODEL: string;
  GUIDED_LESSON_SPEECH_VOICE: string;
  PRACTICE_CHECK_MODEL?: string;
  PRACTICE_CHECK_DAILY_LIMIT?: number;
  PRACTICE_CHECK_MINUTE_LIMIT?: number;
  MATERIAL_JOB_CALLS: number;
  MATERIAL_JOB_INPUT_TOKENS: number;
  MATERIAL_JOB_OUTPUT_TOKENS: number;
  MATERIAL_STAGE_INPUT_TOKENS: number;
  MATERIAL_STAGE_OUTPUT_TOKENS: number;
  MATERIAL_COMPOSITION_OUTPUT_TOKENS: number;
  MATERIAL_COMPOSITION_TIMEOUT_MS: number;
  MATERIAL_JOB_DEADLINE_MS: number;
  VOICEOVER_DAILY_CHARACTERS: number;
  VOICEOVER_GLOBAL_DAILY_CHARACTERS: number;
  VOICEOVER_GLOBAL_STREAMS: number;
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
      CLASSROOM_INSIGHT_COLLECTION_POLICY: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .default('classroom-learning-v1'),
      CLASSROOM_INSIGHT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
      GUIDED_LESSON_MODEL: z.string().min(1).max(100).default('gpt-5.4'),
      GUIDED_LESSON_SPEECH_MODEL: z.string().min(1).max(100).default('gpt-4o-mini-tts'),
      GUIDED_LESSON_SPEECH_VOICE: z
        .enum([
          'marin',
          'cedar',
          'alloy',
          'ash',
          'ballad',
          'coral',
          'echo',
          'fable',
          'nova',
          'onyx',
          'sage',
          'shimmer',
          'verse',
        ])
        .default('marin'),
      PRACTICE_CHECK_MODEL: z.string().min(1).max(100).default('gpt-5.4'),
      PRACTICE_CHECK_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(30),
      PRACTICE_CHECK_MINUTE_LIMIT: z.coerce.number().int().min(1).max(10).default(5),
      MATERIAL_JOB_CALLS: z.coerce.number().int().min(1).max(100).default(24),
      MATERIAL_JOB_INPUT_TOKENS: z.coerce.number().int().positive().max(1000000).default(150000),
      MATERIAL_JOB_OUTPUT_TOKENS: z.coerce
        .number()
        .int()
        .positive()
        .max(200000)
        .default(defaultMaterialGenerationPolicy.outputTokens),
      MATERIAL_STAGE_INPUT_TOKENS: z.coerce
        .number()
        .int()
        .positive()
        .max(100000)
        .default(defaultMaterialGenerationPolicy.stageInputTokens),
      MATERIAL_STAGE_OUTPUT_TOKENS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(8000)
        .default(defaultMaterialGenerationPolicy.stageOutputTokens),
      MATERIAL_COMPOSITION_OUTPUT_TOKENS: z.coerce
        .number()
        .int()
        .min(2000)
        .max(100000)
        .default(defaultMaterialGenerationPolicy.compositionOutputTokens),
      MATERIAL_COMPOSITION_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(90000)
        .max(540000)
        .default(defaultMaterialGenerationPolicy.compositionTimeoutMs),
      MATERIAL_JOB_DEADLINE_MS: z.coerce.number().int().positive().max(540000).default(540000),
      VOICEOVER_DAILY_CHARACTERS: z.coerce.number().int().positive().max(1000000).default(30000),
      VOICEOVER_GLOBAL_DAILY_CHARACTERS: z.coerce
        .number()
        .int()
        .positive()
        .max(100000000)
        .default(1000000),
      VOICEOVER_GLOBAL_STREAMS: z.coerce.number().int().positive().max(1000).default(20),
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
