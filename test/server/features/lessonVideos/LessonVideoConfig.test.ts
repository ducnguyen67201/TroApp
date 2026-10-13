import { expect, it } from 'vitest';
import {
  LessonVideoConfigSchema,
  readLessonVideoConfig,
} from '../../../../src/server/config/LessonVideoConfig.js';

it('reserves at most six paid dispatches and 72K input/output tokens for the new policy', () => {
  const settings = readLessonVideoConfig();
  expect(settings.content.attempts + settings.visual.maxScenes * settings.visual.attempts).toBe(6);
  const input =
    settings.content.attempts * settings.content.inputTokens +
    settings.visual.maxScenes * settings.visual.attempts * settings.visual.inputTokens;
  const output =
    settings.content.attempts * settings.content.outputTokens +
    settings.visual.maxScenes * settings.visual.attempts * settings.visual.outputTokens;
  expect(input).toBe(48000);
  expect(output).toBe(24000);
  expect(
    input * settings.budget.inputMicroUsdPerToken + output * settings.budget.outputMicroUsdPerToken,
  ).toBe(144000);
});

it('rejects an enabled policy whose combined writer and animation reservation is unaffordable', () => {
  const settings = readLessonVideoConfig();
  expect(() =>
    readLessonVideoConfig({
      ...settings,
      budget: { ...settings.budget, revisionMicroUsd: 143999 },
    }),
  ).toThrow('configuration is invalid');
  expect(() =>
    readLessonVideoConfig({ ...settings, content: { ...settings.content, attempts: 3 } }),
  ).toThrow('configuration is invalid');
});

it('keeps legacy three-attempt policy snapshots baseline-only without granting visual attempts', () => {
  const settings = readLessonVideoConfig();
  const legacy = LessonVideoConfigSchema.parse({
    ...settings,
    content: { ...settings.content, attempts: 3 },
    visual: undefined,
  });
  expect(legacy.visual.enabled).toBe(false);
  expect(legacy.content.attempts).toBe(3);
});

it('reserves a baseline render attempt after all allowed custom-source attempts', () => {
  const settings = readLessonVideoConfig();
  expect(() =>
    readLessonVideoConfig({ ...settings, render: { ...settings.render, attempts: 2 } }),
  ).toThrow('configuration is invalid');
  expect(
    readLessonVideoConfig({
      ...settings,
      visual: { ...settings.visual, attempts: 1 },
      render: { ...settings.render, attempts: 2 },
    }).render.attempts,
  ).toBe(2);
});

it('bounds manual media recovery and keeps missing legacy policy at zero', () => {
  const settings = readLessonVideoConfig();
  expect(settings.render.recoveries).toBe(1);
  expect(
    LessonVideoConfigSchema.parse({
      ...settings,
      render: { ...settings.render, recoveries: undefined },
    }).render.recoveries,
  ).toBe(0);
  expect(() =>
    readLessonVideoConfig({ ...settings, render: { ...settings.render, recoveries: 2 } }),
  ).toThrow('configuration is invalid');
});
