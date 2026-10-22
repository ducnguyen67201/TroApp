import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  formatObservationEncodingEvaluation,
  runObservationEncodingEvaluation,
  type ObservationEncodingEvaluationReport,
} from '../test/evaluation/encoding/ObservationEncodingEvaluation.js';

export interface BenchmarkObservationEncodingOptions {
  output: string | undefined;
}

export function parseBenchmarkObservationEncodingOptions(
  args: string[],
): BenchmarkObservationEncodingOptions {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: { output: { type: 'string' } },
    allowPositionals: false,
  });
  return {
    output:
      values.output === undefined
        ? undefined
        : z.string().trim().min(1).max(4096).parse(values.output),
  };
}

/** Offline authored comparison. No native desktop or model request is started;
 * prior reports are never overwritten and outputs are owner-readable files. */
export async function benchmarkObservationEncoding(
  options: BenchmarkObservationEncodingOptions,
): Promise<{ directory: string; report: ObservationEncodingEvaluationReport }> {
  const directory = resolve(
    options.output ??
      join(
        '.tro-development',
        'evaluations',
        `ObservationEncoding-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
      ),
  );
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const report = runObservationEncodingEvaluation();
  await writeFile(join(directory, 'Report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(join(directory, 'Report.md'), formatObservationEncodingEvaluation(report), {
    flag: 'wx',
    mode: 0o600,
  });
  return { directory, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve()
    .then(() =>
      benchmarkObservationEncoding(parseBenchmarkObservationEncodingOptions(process.argv.slice(2))),
    )
    .then(({ directory, report }) => {
      console.info(formatObservationEncodingEvaluation(report));
      console.info(`Report: ${join(directory, 'Report.md')}`);
      if (!report.allRoundtripsExact || !report.noTokenRegressions) {
        process.exitCode = 1;
      }
    })
    .catch(() => {
      console.error(
        'Observation-encoding evaluation failed. Check the options and fresh output directory.',
      );
      process.exitCode = 1;
    });
}
