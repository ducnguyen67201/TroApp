import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInteractiveEvaluationChildEnv } from '../../scripts/Env.js';
import {
  readInteractiveCredential,
  describeInteractiveLaunchFailure,
  resolveInteractiveEvaluationScenario,
  resolveInteractiveEvaluationPricing,
} from '../../scripts/RunInteractiveEvaluations.js';
import { InteractiveEvaluationLimits } from '../evaluation/interactive/InteractiveEvaluationConfig.js';
import { parseInteractiveEvaluationOptions } from '../evaluation/interactive/InteractiveEvaluationConfig.js';
import { getDefaultEvaluationScenario } from '../evaluation/interactive/ScenarioCatalog.js';

const scenarioDirectories: string[] = [];

it('accepts an explicit local rate file without accepting an empty path', () => {
  expect(
    parseInteractiveEvaluationOptions(['--pricing-file', '/synthetic/Pricing.json']),
  ).toMatchObject({ pricingFile: '/synthetic/Pricing.json' });
  expect(() => parseInteractiveEvaluationOptions(['--pricing-file', ''])).toThrow();
});

it('finds a conventional rate file for signed-in menu runs and rejects invalid explicit files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroBenchmarkPricing-'));
  scenarioDirectories.push(directory);
  const options = parseInteractiveEvaluationOptions([]);
  expect(await resolveInteractiveEvaluationPricing(options, directory)).toEqual(options);
  const parent = join(directory, '.tro-development', 'evaluations');
  await mkdir(parent, { recursive: true });
  const path = join(parent, 'Pricing.json');
  const pricing = {
    schemaVersion: 1,
    currency: 'USD',
    id: 'SyntheticTestPrices',
    source: 'Authored test data',
    effectiveAt: '2026-10-21T00:00:00.000Z',
    models: [
      {
        model: 'example-model',
        missingCacheWriteTokens: 'unknown',
        tiers: [
          {
            maximumInputTokens: 1000,
            inputUsdPerMillion: 2,
            cachedInputUsdPerMillion: 0.2,
            cacheWriteInputUsdPerMillion: null,
            outputUsdPerMillion: 8,
          },
        ],
      },
    ],
  };
  await writeFile(path, JSON.stringify(pricing));
  expect((await resolveInteractiveEvaluationPricing(options, directory)).config.pricing).toEqual(
    pricing,
  );
  await writeFile(path, '{invalid');
  await expect(resolveInteractiveEvaluationPricing(options, directory)).rejects.toThrow();
  await expect(
    resolveInteractiveEvaluationPricing({ ...options, pricingFile: 'Missing.json' }, directory),
  ).rejects.toThrow();
});

afterEach(async () => {
  for (const directory of scenarioDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('loads and calibrates a selected manifest before building or dispatching an agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroScenarioSelection-'));
  scenarioDirectories.push(directory);
  const path = join(directory, 'Scenario.json');
  const scenario = getDefaultEvaluationScenario('vscode');
  await writeFile(path, JSON.stringify(scenario));
  const options = parseInteractiveEvaluationOptions([
    '--application',
    'vscode',
    '--scenario-file',
    path,
  ]);
  await expect(resolveInteractiveEvaluationScenario(options)).resolves.toMatchObject({
    config: { evaluationScenario: scenario },
  });
  if (scenario.application !== 'vscode') {
    throw new Error('Expected Python fixture.');
  }
  scenario.fixture.source = 'print("unrelated program")';
  scenario.fixture.cursor = { line: 1, column: 1 };
  await writeFile(path, JSON.stringify(scenario));
  await expect(resolveInteractiveEvaluationScenario(options)).rejects.toThrow(
    'scenario_calibration_failed',
  );
});

it('freezes default real-app manifests while leaving the controlled matrix unchanged', async () => {
  const python = await resolveInteractiveEvaluationScenario(
    parseInteractiveEvaluationOptions(['--application', 'vscode']),
  );
  expect(python.config.evaluationScenario?.application).toBe('vscode');
  const controlled = await resolveInteractiveEvaluationScenario(
    parseInteractiveEvaluationOptions([]),
  );
  expect(controlled.config.evaluationScenario).toBeNull();
});

async function* createCredentialInput(chunks: readonly unknown[]): AsyncGenerator {
  for (const chunk of chunks) {
    yield await Promise.resolve(chunk);
  }
}

function createCredential(expiresInMs = 60_000): { token: string; expiresAt: string } {
  return {
    token: 'synthetic-scoped-gateway-test-token',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

describe('interactive credential stdin', () => {
  it('retains bounded setup failure codes without raw content or credentials', () => {
    const error = Object.assign(
      new TypeError('private token or configuration must not enter the diagnostic'),
      { code: 'ENOENT', stdout: 'private child output' },
    );
    expect(describeInteractiveLaunchFailure(error)).toEqual({
      errorType: 'TypeError',
      errorCode: 'ENOENT',
    });
    expect(describeInteractiveLaunchFailure({ name: 'private', code: 'private-token' })).toEqual({
      errorType: 'unknown',
      errorCode: null,
    });
  });
  it('accepts a scoped credential split across string and Buffer chunks', async () => {
    const credential = createCredential();
    const serialized = JSON.stringify(credential);
    const split = Math.floor(serialized.length / 2);
    await expect(
      readInteractiveCredential(
        createCredentialInput([serialized.slice(0, split), Buffer.from(serialized.slice(split))]),
      ),
    ).resolves.toEqual(credential);
  });

  it.each([-60_000, 0, 4000])(
    'rejects expired or nearly expired credentials (%i ms)',
    async (expiresInMs) => {
      await expect(
        readInteractiveCredential(
          createCredentialInput([JSON.stringify(createCredential(expiresInMs))]),
        ),
      ).rejects.toThrow('short_lived_gateway_credential_required');
    },
  );

  it('rejects a provider API key even when the expiry is valid', async () => {
    await expect(
      readInteractiveCredential(
        createCredentialInput([
          JSON.stringify({ ...createCredential(), token: 'sk-synthetic-provider-test-key' }),
        ]),
      ),
    ).rejects.toThrow('short_lived_gateway_credential_required');
  });

  it('bounds cumulative input bytes before parsing the credential', async () => {
    const first = Buffer.alloc(InteractiveEvaluationLimits.MAXIMUM_BOOTSTRAP_BYTES, ' ');
    await expect(readInteractiveCredential(createCredentialInput([first, ' ']))).rejects.toThrow(
      'credential_input_too_large',
    );
  });

  it('rejects chunks that are not text or bytes', async () => {
    await expect(
      readInteractiveCredential(createCredentialInput([{ token: 'synthetic-object-input' }])),
    ).rejects.toThrow('invalid_credential_input');
  });

  it.each([
    '',
    '{invalid',
    '{}',
    '{"token":"synthetic-missing-expiry"}',
    '{"token":"synthetic-invalid-expiry","expiresAt":"tomorrow"}',
  ])('rejects malformed credential input %j', async (input) => {
    await expect(readInteractiveCredential(createCredentialInput([input]))).rejects.toThrow();
  });

  it('rejects unexpected fields rather than accepting raw provider configuration', async () => {
    await expect(
      readInteractiveCredential(
        createCredentialInput([
          JSON.stringify({ ...createCredential(), apiKey: 'synthetic-unexpected-provider-field' }),
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe('interactive host child environment', () => {
  it('keeps operating-system startup values and strips credentials and Node injection', () => {
    const environment = {
      PATH: '/synthetic/bin',
      HOME: '/synthetic/home',
      TMPDIR: '/synthetic/tmp',
      DISPLAY: ':17',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'synthetic-provider-key',
      AUTH_SECRET: 'synthetic-auth-secret',
      DATABASE_URL: 'synthetic-database-url',
      NODE_OPTIONS: '--require=synthetic-injected-file',
      ELECTRON_RUN_AS_NODE: '1',
    } satisfies NodeJS.ProcessEnv;
    const original = { ...environment };
    expect(readInteractiveEvaluationChildEnv(environment)).toEqual({
      PATH: environment.PATH,
      HOME: environment.HOME,
      TMPDIR: environment.TMPDIR,
      DISPLAY: environment.DISPLAY,
      LANG: environment.LANG,
    });
    expect(environment).toEqual(original);
  });

  it('preserves Windows startup paths without forwarding unrelated application data', () => {
    expect(
      readInteractiveEvaluationChildEnv({
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Synthetic\\Temp',
        TMP: 'C:\\Synthetic\\Tmp',
        APPDATA: 'C:\\Synthetic\\PrivateProfile',
        TRO_MODEL_TOKEN: 'synthetic-scoped-token',
      }),
    ).toEqual({
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Synthetic\\Temp',
      TMP: 'C:\\Synthetic\\Tmp',
    });
  });

  it.each([{}, { PATH: '' }])('requires an executable search path', (environment) => {
    expect(() => readInteractiveEvaluationChildEnv(environment)).toThrow(
      'Evaluation host environment is invalid.',
    );
  });
});
