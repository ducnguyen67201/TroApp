import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readEvaluationScenarioInputsFile } from '../test/evaluation/interactive/ReadEvaluationScenarios.js';
import {
  formatEvaluationScenarioValidation,
  validateEvaluationScenarios,
  type EvaluationScenarioValidationReport,
} from '../test/evaluation/interactive/ValidateEvaluationScenarios.js';

export interface ValidateScenarioCommandOptions {
  input: string;
  output: string | undefined;
}

export function parseValidateScenarioOptions(args: string[]): ValidateScenarioCommandOptions {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: { input: { type: 'string' }, output: { type: 'string' } },
    allowPositionals: false,
  });
  return { input: z.string().trim().min(1).parse(values.input), output: values.output };
}

/** Regrades a local collection without launching any app, agent or provider. */
export async function runScenarioValidation(
  options: ValidateScenarioCommandOptions,
): Promise<EvaluationScenarioValidationReport> {
  const scenarios = await readEvaluationScenarioInputsFile(resolve(options.input));
  const report = validateEvaluationScenarios(scenarios);
  if (options.output !== undefined) {
    const directory = resolve(options.output);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'Validation.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(join(directory, 'Validation.md'), formatEvaluationScenarioValidation(report), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve()
    .then(() => runScenarioValidation(parseValidateScenarioOptions(process.argv.slice(2))))
    .then((report) => {
      console.info(formatEvaluationScenarioValidation(report));
      process.exitCode = report.passed ? 0 : 1;
    })
    .catch(() => {
      console.error(
        'Scenario validation failed. Supply a bounded valid collection and an unused output directory.',
      );
      process.exitCode = 1;
    });
}
