import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  formatQuestionContextEvaluation,
  QuestionContextVariant,
  runQuestionContextEvaluation,
  type QuestionContextEvaluationReport,
} from '../test/evaluation/context/QuestionContextEvaluation.js';

export interface BenchmarkQuestionContextOptions {
  quick: boolean;
  output: string | undefined;
}

export function parseBenchmarkQuestionContextOptions(
  args: string[],
): BenchmarkQuestionContextOptions {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: { quick: { type: 'boolean', default: false }, output: { type: 'string' } },
    allowPositionals: false,
  });
  return {
    quick: values.quick,
    output:
      values.output === undefined ? undefined : z.string().min(1).max(4096).parse(values.output),
  };
}

/** Run internal synthetic local comparisons. No native application, database or
 * provider is started; output always goes to a fresh owner-readable directory. */
export async function benchmarkQuestionContext(
  options: BenchmarkQuestionContextOptions,
): Promise<{ directory: string; report: QuestionContextEvaluationReport }> {
  const directory = resolve(
    options.output ??
      join(
        '.tro-development',
        'evaluations',
        `QuestionContext-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
      ),
  );
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const report = await runQuestionContextEvaluation({ includeThreeHour: !options.quick });
  await writeFile(join(directory, 'Report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(join(directory, 'Report.md'), formatQuestionContextEvaluation(report), {
    flag: 'wx',
    mode: 0o600,
  });
  return { directory, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve()
    .then(() =>
      benchmarkQuestionContext(parseBenchmarkQuestionContextOptions(process.argv.slice(2))),
    )
    .then(({ directory, report }) => {
      console.info(formatQuestionContextEvaluation(report));
      console.info(`Report: ${join(directory, 'Report.md')}`);
      const questionCases = report.results.filter(
        (result) => result.variant === QuestionContextVariant.QUESTION,
      );
      if (
        !report.pairedCorpusDigestsMatch ||
        questionCases.some(
          (result) =>
            !Object.values(result.scopeControls).every(Boolean) ||
            result.asks.some((ask) => ask.modelFacts.length !== ask.requiredFacts.length),
        )
      ) {
        process.exitCode = 1;
      }
    })
    .catch(() => {
      console.error(
        'Question-context evaluation failed. Check the options and fresh output directory.',
      );
      process.exitCode = 1;
    });
}
