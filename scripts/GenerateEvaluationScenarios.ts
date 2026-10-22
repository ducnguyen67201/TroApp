import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { EvaluationScenarioApplication } from '../test/evaluation/interactive/EvaluationScenario.js';
import {
  generateEvaluationScenarios,
  type GenerateEvaluationScenariosOptions,
} from '../test/evaluation/interactive/GenerateEvaluationScenarios.js';
import {
  formatEvaluationScenarioValidation,
  validateEvaluationScenarios,
  type EvaluationScenarioValidationReport,
} from '../test/evaluation/interactive/ValidateEvaluationScenarios.js';

export interface GenerateScenarioCommandOptions {
  generation: GenerateEvaluationScenariosOptions;
  output: string | undefined;
}

function readIntegerOption(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number(z.string().regex(/^\d+$/).max(10).parse(value));
}

export function parseGenerateScenarioOptions(args: string[]): GenerateScenarioCommandOptions {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      seed: { type: 'string' },
      count: { type: 'string' },
      application: { type: 'string' },
      output: { type: 'string' },
    },
    allowPositionals: false,
  });
  const seed = readIntegerOption(values.seed);
  const count = readIntegerOption(values.count);
  const application =
    values.application === undefined
      ? undefined
      : z.enum(EvaluationScenarioApplication).parse(values.application);
  return {
    generation: {
      ...(seed === undefined ? {} : { seed }),
      ...(count === undefined ? {} : { count }),
      ...(application === undefined ? {} : { application }),
    },
    output: values.output,
  };
}

/** Creates a new local internal data package. No existing folder is overwritten,
 * no student recording is read, and no model or application is launched. */
export async function runScenarioGeneration(
  options: GenerateScenarioCommandOptions,
): Promise<{ directory: string; validation: EvaluationScenarioValidationReport }> {
  const scenarios = generateEvaluationScenarios(options.generation);
  const validation = validateEvaluationScenarios(scenarios);
  if (!validation.passed) {
    throw new Error('generated_scenarios_failed_validation');
  }
  const directory = resolve(
    options.output ??
      join(
        '.tro-development',
        'evaluations',
        `Scenarios-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
      ),
  );
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  for (const scenario of scenarios) {
    const caseDirectory = join(directory, scenario.id);
    await mkdir(caseDirectory, { mode: 0o700 });
    await writeFile(
      join(caseDirectory, 'Scenario.json'),
      `${JSON.stringify(scenario, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  }
  await writeFile(join(directory, 'Scenarios.json'), `${JSON.stringify(scenarios, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(join(directory, 'Validation.json'), `${JSON.stringify(validation, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(
    join(directory, 'Validation.md'),
    formatEvaluationScenarioValidation(validation),
    { flag: 'wx', mode: 0o600 },
  );
  return { directory, validation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve()
    .then(() => runScenarioGeneration(parseGenerateScenarioOptions(process.argv.slice(2))))
    .then(({ directory, validation }) => {
      console.info(
        `Generated ${String(validation.scenarios.length)} distinct internal cases. Local calibration: PASS. Model calls: 0.`,
      );
      console.info(`Scenario package: ${directory}`);
    })
    .catch(() => {
      console.error(
        'Scenario generation failed. Check the options, supported count and unused output directory.',
      );
      process.exitCode = 1;
    });
}
