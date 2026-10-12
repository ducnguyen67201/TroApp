import { expect, it } from 'vitest';
import {
  PracticeCheckConfig,
  readPracticeCheckConfig,
  ClassroomInsightConfig,
  readClassroomInsightConfig,
  MaterialConfig,
  readMaterialConfig,
  VoiceoverConfig,
  readVoiceoverAllowanceConfig,
} from '../../../src/server/config/Index.js';
import { defaultMaterialGenerationPolicy } from '../../../src/server/features/materials/application/MaterialGeneration.js';

it('accepts reviewed practice settings while preserving admission bounds', () => {
  expect(readPracticeCheckConfig()).toMatchObject({ policy: { dailyChecks: 30, minuteChecks: 5 } });
  expect(
    readPracticeCheckConfig({
      ...PracticeCheckConfig,
      policy: { dailyChecks: 100, minuteChecks: 10 },
    }).policy,
  ).toEqual({ dailyChecks: 100, minuteChecks: 10 });
  for (const policy of [
    { dailyChecks: 0, minuteChecks: 5 },
    { dailyChecks: 101, minuteChecks: 5 },
    { dailyChecks: 30, minuteChecks: 0 },
    { dailyChecks: 30, minuteChecks: 11 },
    { dailyChecks: 1.5, minuteChecks: 5 },
  ]) {
    expect(() => readPracticeCheckConfig({ ...PracticeCheckConfig, policy })).toThrow(
      'Practice check configuration is invalid.',
    );
  }
});

it('preserves collection provenance and rolling retention defaults with validated overrides', () => {
  expect(readClassroomInsightConfig()).toEqual({
    collectionPolicy: 'classroom-learning-v1',
    retentionDays: 180,
  });
  expect(readClassroomInsightConfig({ collectionPolicy: ' pilot-v1 ', retentionDays: 30 })).toEqual(
    {
      collectionPolicy: 'pilot-v1',
      retentionDays: 30,
    },
  );
});

it('rejects invalid provenance and retention settings before startup', () => {
  for (const configuration of [
    { ...ClassroomInsightConfig, collectionPolicy: '   ' },
    { ...ClassroomInsightConfig, collectionPolicy: 'x'.repeat(201) },
    { ...ClassroomInsightConfig, retentionDays: 0 },
    { ...ClassroomInsightConfig, retentionDays: 3651 },
    { ...ClassroomInsightConfig, retentionDays: 1.5 },
  ]) {
    expect(() => readClassroomInsightConfig(configuration)).toThrow(
      'Classroom insight configuration is invalid.',
    );
  }
});

it('uses one policy for startup and default application consumers, with separate composition allowances', () => {
  expect(defaultMaterialGenerationPolicy).toBe(MaterialConfig.generation);
  expect(readMaterialConfig().generation).toMatchObject({
    stageOutputTokens: 2000,
    compositionOutputTokens: 60_000,
    stageInputTokens: 100_000,
    outputTokens: 160_000,
    compositionTimeoutMs: 240_000,
  });
  const configured = readMaterialConfig({
    generation: { ...MaterialConfig.generation, compositionOutputTokens: 100_000 },
  });
  expect(configured.generation.compositionOutputTokens).toBe(100_000);
  expect(configured.generation.stageOutputTokens).toBe(2000);
  expect(() =>
    readMaterialConfig({
      generation: { ...MaterialConfig.generation, compositionOutputTokens: 100_001 },
    }),
  ).toThrow('Material configuration is invalid.');
});

it('validates composition timeouts separately from the overall job deadline', () => {
  const configured = readMaterialConfig({
    generation: { ...MaterialConfig.generation, compositionTimeoutMs: 300_000 },
  });
  expect(configured.generation.compositionTimeoutMs).toBe(300_000);
  expect(configured.generation.deadlineMs).toBe(540_000);
  expect(() =>
    readMaterialConfig({
      generation: { ...MaterialConfig.generation, compositionTimeoutMs: 540_001 },
    }),
  ).toThrow('Material configuration is invalid.');
});

it('keeps daily, global and concurrent voiceover allowances independently configurable', () => {
  expect(readVoiceoverAllowanceConfig()).toEqual({
    dailyCharacters: 30_000,
    globalDailyCharacters: 1_000_000,
    globalStreams: 20,
  });
  expect(readVoiceoverAllowanceConfig({ ...VoiceoverConfig.ALLOWANCE, globalStreams: 1 })).toEqual({
    dailyCharacters: 30_000,
    globalDailyCharacters: 1_000_000,
    globalStreams: 1,
  });
  for (const configuration of [
    { ...VoiceoverConfig.ALLOWANCE, dailyCharacters: 0 },
    { ...VoiceoverConfig.ALLOWANCE, dailyCharacters: 1_000_001 },
    { ...VoiceoverConfig.ALLOWANCE, globalDailyCharacters: 0 },
    { ...VoiceoverConfig.ALLOWANCE, globalDailyCharacters: 100_000_001 },
    { ...VoiceoverConfig.ALLOWANCE, globalStreams: 0 },
    { ...VoiceoverConfig.ALLOWANCE, globalStreams: 1001 },
    { ...VoiceoverConfig.ALLOWANCE, globalStreams: 1.5 },
  ]) {
    expect(() => readVoiceoverAllowanceConfig(configuration)).toThrow(
      'Voiceover allowance configuration is invalid.',
    );
  }
});
