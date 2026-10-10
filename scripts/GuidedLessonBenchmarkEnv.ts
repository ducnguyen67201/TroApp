import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/** Read only the provider and isolated render settings needed by a manual benchmark. */
export function readGuidedLessonBenchmarkEnv(environment: NodeJS.ProcessEnv): {
  apiKey: string;
  model: string;
  codingModel: string;
  speechModel: string;
  speechVoice: string;
  renderImage: string;
} {
  const model = z.string().min(1).max(100);
  const validated = createEnv({
    server: {
      OPENAI_API_KEY: z.string().min(1).max(1000),
      GUIDED_LESSON_MODEL: model.default('gpt-5.4'),
      GUIDED_LESSON_CODING_MODEL: model.default('gpt-5.4'),
      GUIDED_LESSON_SPEECH_MODEL: model.default('gpt-4o-mini-tts'),
      GUIDED_LESSON_SPEECH_VOICE: model.default('marin'),
      GUIDED_LESSON_RENDER_IMAGE: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/)
        .default('tro-lesson-renderer:local'),
    },
    runtimeEnv: environment,
    emptyStringAsUndefined: true,
    onValidationError: () => {
      throw new Error('Guided lesson benchmark provider configuration is invalid.');
    },
  });
  return {
    apiKey: validated.OPENAI_API_KEY,
    model: validated.GUIDED_LESSON_MODEL,
    codingModel: validated.GUIDED_LESSON_CODING_MODEL,
    speechModel: validated.GUIDED_LESSON_SPEECH_MODEL,
    speechVoice: validated.GUIDED_LESSON_SPEECH_VOICE,
    renderImage: validated.GUIDED_LESSON_RENDER_IMAGE,
  };
}
