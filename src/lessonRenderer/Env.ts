import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/** Validate renderer startup settings without exposing secrets in validation errors. */
export function readRendererEnv(environment: NodeJS.ProcessEnv) {
  return createEnv({
    server: {
      // HTTP listener. Docker overrides HOST to accept connections from the API.
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3010),

      // Shared credential used by the API to authenticate renderer requests.
      LESSON_RENDER_SECRET: z.string().min(32),

      // Directory containing the prebuilt Remotion presentation.
      LESSON_RENDER_BUNDLE: z.string().default('dist/lesson-bundle'),

      // Optional browser executable; otherwise Remotion resolves its browser.
      CHROME_PATH: z.string().optional(),
    },

    runtimeEnv: environment,

    onValidationError: () => {
      throw new Error('Renderer configuration is invalid.');
    },
  });
}
