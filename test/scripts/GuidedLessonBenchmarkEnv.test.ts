import { describe, expect, it } from 'vitest';
import { readGuidedLessonBenchmarkEnv } from '../../scripts/GuidedLessonBenchmarkEnv.js';

describe('manual guided lesson benchmark environment', () => {
  it('requires only benchmark providers and no database or account settings', () => {
    const environment = { OPENAI_API_KEY: 'example-key' };
    expect(readGuidedLessonBenchmarkEnv(environment)).toEqual({
      apiKey: 'example-key',
      model: 'gpt-5.4',
      codingModel: 'gpt-5.4',
      speechModel: 'gpt-4o-mini-tts',
      speechVoice: 'marin',
      renderImage: 'tro-lesson-renderer:local',
    });
    expect(environment).toEqual({ OPENAI_API_KEY: 'example-key' });
  });

  it('returns a static error without exposing invalid configuration', () => {
    expect(() =>
      readGuidedLessonBenchmarkEnv({
        OPENAI_API_KEY: 'PRIVATE KEY',
        GUIDED_LESSON_RENDER_IMAGE: 'PRIVATE INVALID IMAGE',
      }),
    ).toThrow('Guided lesson benchmark provider configuration is invalid.');
    expect(() => readGuidedLessonBenchmarkEnv({})).toThrow();
  });
});
