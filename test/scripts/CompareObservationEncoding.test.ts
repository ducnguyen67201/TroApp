import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  compareObservationEncoding,
  parseObservationComparisonOptions,
  type ObservationComparisonPorts,
} from '../../scripts/CompareObservationEncoding.js';
import { ModelObservationProjection } from '../../src/desktop/worker/agent/ModelObservationProjection.js';
import { createInteractiveTrialPlan } from '../evaluation/interactive/InteractiveEvaluationConfig.js';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

function createOptions(output: string) {
  return parseObservationComparisonOptions([
    '--live',
    '--dedicated-desktop',
    '--credential-stdin',
    '--output',
    output,
  ]);
}

it('defaults to the prior reviewed missing-break Python scenario and fixes all other experimental axes', () => {
  const options = createOptions('/authored/report');
  expect(options.config).toMatchObject({
    application: 'vscode',
    taskMode: 'execute',
    variants: ['ContextOn'],
    repetitions: 1,
    evaluationScenario: { id: 'PythonMissingBreakSeed1' },
  });
  for (const flags of [
    [],
    ['--live'],
    ['--live', '--dedicated-desktop'],
    ['--live', '--dedicated-desktop', '--credential-stdin', '--teach'],
    ['--live', '--dedicated-desktop', '--credential-stdin', '--request', 'custom question'],
  ]) {
    expect(() => parseObservationComparisonOptions(flags)).toThrow();
  }
});

it('rejects unsupported direct-function configurations before dispatching any trial', async () => {
  const options = createOptions('/authored/report');
  options.config.taskMode = 'teach';
  const run = vi.fn<ObservationComparisonPorts['run']>();
  const readSourceHashes = vi.fn<ObservationComparisonPorts['readSourceHashes']>();
  await expect(
    compareObservationEncoding(
      options,
      { token: 'synthetic-scoped-token', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { run, readSourceHashes },
    ),
  ).rejects.toThrow('encoding_comparison_requires_one_live_python_execution_per_projection');
  expect(run).not.toHaveBeenCalled();
  expect(readSourceHashes).not.toHaveBeenCalled();
});

it('runs exactly two fresh normal trials with the same credential/question/fixture and saves readable accounting', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'TroObservationComparison-'));
  directories.push(parent);
  const options = createOptions(join(parent, 'Pair'));
  const credential = {
    token: 'synthetic-scoped-token-not-persisted',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const run = vi.fn<ObservationComparisonPorts['run']>(async (trialOptions) => {
    if (!trialOptions.output) {
      throw new Error('Expected separate output.');
    }
    const plan = createInteractiveTrialPlan(trialOptions.config)[0];
    if (!plan) {
      throw new Error('Expected one trial plan.');
    }
    await mkdir(trialOptions.output);
    await writeFile(
      join(trialOptions.output, 'Report.json'),
      JSON.stringify({
        schemaVersion: 1,
        config: trialOptions.config,
        model: 'gpt-6.1-sol',
        applicationRevision: 'a'.repeat(40),
        outcome: 'finished',
        trials: [
          {
            trialId: randomUUID(),
            scenarioId: plan.caseId,
            startingStateId: plan.startingStateId,
            status: 'settled',
            outcomePassed: true,
            reasons: [],
            taskDurationMs: 1000,
            firstObservedInputMs: 200,
            firstVerifiedOutcomeMs: 900,
            cursorMoved: true,
            agent: {
              failed: false,
              durationMs: 990,
              modelRequests: [],
              toolCalls: 2,
              mutationCalls: 1,
              resultKind: 'completed',
              taskOutcomeStatus: 'unverified',
              observationProjections: [],
              observationProjectionOverflow: false,
            },
            recording: { traceComplete: true },
          },
        ],
      }),
    );
    return {
      outputDirectory: trialOptions.output,
      outcome: 'finished',
      preflightCases: 1,
      attemptedTrials: 1,
      plannedTrials: 1,
    };
  });
  const readSourceHashes = vi
    .fn<ObservationComparisonPorts['readSourceHashes']>()
    .mockResolvedValue({ formatter: 'c'.repeat(64) });
  const result = await compareObservationEncoding(options, credential, { run, readSourceHashes });
  expect(run).toHaveBeenCalledTimes(2);
  const before = run.mock.calls[0];
  const after = run.mock.calls[1];
  expect(before?.[1]).toBe(credential);
  expect(after?.[1]).toBe(credential);
  expect(before?.[0].config.observationProjection).toBe(ModelObservationProjection.LEGACY_JSON);
  expect(after?.[0].config).toEqual({
    ...before?.[0].config,
    observationProjection: ModelObservationProjection.ADAPTIVE_TOON,
  });
  expect(before?.[0].output).not.toBe(after?.[0].output);
  expect(result.report).toMatchObject({
    matchingStartingState: true,
    matchingConfiguredModel: true,
    matchingSourceHashes: true,
    bothSolved: true,
  });
  const report = await readFile(join(result.outputDirectory, 'Report.md'), 'utf8');
  expect(report).toContain('legacy-json');
  expect(report).toContain('adaptive-toon');
  expect(report).not.toContain(credential.token);
  expect(await readFile(join(result.outputDirectory, 'Report.json'), 'utf8')).not.toContain(
    credential.token,
  );
  await expect(
    compareObservationEncoding(options, credential, { run, readSourceHashes }),
  ).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(2);
});
