import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelCredential } from '../src/contracts/AuthSession.js';
import { AgentTaskMode } from '../src/contracts/CursorCompanion.js';
import { ModelObservationProjection } from '../src/desktop/worker/agent/ModelObservationProjection.js';
import {
  InteractiveRunMode,
  InteractiveVariant,
  parseInteractiveEvaluationOptions,
  type InteractiveEvaluationOptions,
} from '../test/evaluation/interactive/InteractiveEvaluationConfig.js';
import { EvaluationApplication } from '../test/evaluation/interactive/EvaluationApplication.js';
import { generateEvaluationScenarios } from '../test/evaluation/interactive/GenerateEvaluationScenarios.js';
import {
  ObservationComparisonInputSchema,
  createObservationEncodingComparisonReport,
  formatObservationEncodingComparisonReport,
  summarizeObservationComparisonRun,
  type ObservationComparisonRow,
  type ObservationEncodingComparisonReport,
} from '../test/evaluation/interactive/ObservationEncodingComparison.js';
import {
  readInteractiveCredential,
  resolveInteractiveEvaluationPricing,
  resolveInteractiveEvaluationScenario,
  runInteractiveEvaluations,
  type InteractiveEvaluationRunResult,
} from './RunInteractiveEvaluations.js';

const ComparisonLimits = { MAXIMUM_REPORT_BYTES: 16 * 1024 * 1024 } as const;
const ProjectionSourceFiles = [
  'src/desktop/worker/agent/ModelObservationProjection.ts',
  'src/desktop/worker/agent/FormatModelObservation.ts',
  'src/desktop/worker/cua/LoggedCuaServer.ts',
] as const;

/** Fix all experimental axes except projection; no optional matrix expansion. */
function assertObservationComparisonConfig(options: InteractiveEvaluationOptions): void {
  if (
    options.config.application !== EvaluationApplication.VSCODE ||
    options.config.taskMode !== AgentTaskMode.EXECUTE ||
    options.config.variants.length !== 1 ||
    options.config.variants[0] !== InteractiveVariant.ON ||
    options.config.repetitions !== 1 ||
    !options.config.singleRequest ||
    options.config.request !== null ||
    options.config.runMode !== InteractiveRunMode.LIVE
  ) {
    throw new Error('encoding_comparison_requires_one_live_python_execution_per_projection');
  }
}

export function parseObservationComparisonOptions(args: string[]): InteractiveEvaluationOptions {
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  const options = parseInteractiveEvaluationOptions([
    '--single',
    '--application',
    EvaluationApplication.VSCODE,
    '--execute',
    '--variant',
    'on',
    '--repetitions',
    '1',
    ...forwarded,
  ]);
  assertObservationComparisonConfig(options);
  if (!options.scenarioFile) {
    const scenario = generateEvaluationScenarios({
      seed: 1,
      application: EvaluationApplication.VSCODE,
    }).find((candidate) => candidate.id === 'PythonMissingBreakSeed1');
    if (!scenario) {
      throw new Error('encoding_comparison_default_scenario_missing');
    }
    options.config.evaluationScenario = scenario;
  }
  return options;
}

export async function readObservationProjectionSourceHashes(): Promise<
  Readonly<Record<string, string>>
> {
  const hashes: Record<string, string> = {};
  for (const path of ProjectionSourceFiles) {
    hashes[path] = createHash('sha256')
      .update(await readFile(resolve(path)))
      .digest('hex');
  }
  return hashes;
}

async function readComparisonInput(directory: string) {
  const file = await open(join(directory, 'Report.json'), 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > ComparisonLimits.MAXIMUM_REPORT_BYTES) {
      throw new Error('encoding_comparison_report_too_large');
    }
    const bytes = Buffer.alloc(ComparisonLimits.MAXIMUM_REPORT_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > ComparisonLimits.MAXIMUM_REPORT_BYTES) {
      throw new Error('encoding_comparison_report_too_large');
    }
    const raw: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    return ObservationComparisonInputSchema.parse(raw);
  } finally {
    await file.close();
  }
}

export interface ObservationComparisonPorts {
  run(
    options: InteractiveEvaluationOptions,
    credential: ModelCredential | null,
  ): Promise<InteractiveEvaluationRunResult>;
  readSourceHashes(): Promise<Readonly<Record<string, string>>>;
}

/** The credential stays in this process and the existing stdin bootstrap. Each
 * normal runner builds a fresh host/profile, worker, exercise and agent history. */
export async function compareObservationEncoding(
  optionsInput: InteractiveEvaluationOptions,
  credential: ModelCredential,
  ports: ObservationComparisonPorts = {
    run: runInteractiveEvaluations,
    readSourceHashes: readObservationProjectionSourceHashes,
  },
): Promise<{ outputDirectory: string; report: ObservationEncodingComparisonReport }> {
  assertObservationComparisonConfig(optionsInput);
  const prepared = await resolveInteractiveEvaluationPricing(
    await resolveInteractiveEvaluationScenario(optionsInput),
  );
  const outputDirectory = resolve(
    optionsInput.output ??
      join(
        '.tro-development',
        'evaluations',
        `ObservationEncodingLive-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
      ),
  );
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { mode: 0o700 });
  console.info(`Observation encoding comparison artifacts: ${outputDirectory}`);
  const rows: ObservationComparisonRow[] = [];
  for (const projection of [
    ModelObservationProjection.LEGACY_JSON,
    ModelObservationProjection.ADAPTIVE_TOON,
  ]) {
    const directory = join(outputDirectory, projection);
    const sourceSha256 = await ports.readSourceHashes();
    let launchCompleted = true;
    try {
      await ports.run(
        {
          config: { ...prepared.config, observationProjection: projection },
          credentialStdin: true,
          output: directory,
        },
        credential,
      );
    } catch {
      launchCompleted = false;
    }
    const afterHashes = await ports.readSourceHashes();
    if (JSON.stringify(sourceSha256) !== JSON.stringify(afterHashes)) {
      throw new Error('encoding_comparison_source_changed_during_run');
    }
    const input = await readComparisonInput(directory);
    if (input.config.observationProjection !== projection) {
      throw new Error('encoding_comparison_projection_mismatch');
    }
    rows.push(summarizeObservationComparisonRun(input, directory, launchCompleted, sourceSha256));
    const report = createObservationEncodingComparisonReport(rows);
    await writeFile(join(outputDirectory, 'Report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(outputDirectory, 'Report.md'),
      formatObservationEncodingComparisonReport(report),
      { mode: 0o600 },
    );
  }
  return { outputDirectory, report: createObservationEncodingComparisonReport(rows) };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    const options = parseObservationComparisonOptions(process.argv.slice(2));
    const credential = await readInteractiveCredential(process.stdin);
    const { outputDirectory, report } = await compareObservationEncoding(options, credential);
    console.info(formatObservationEncodingComparisonReport(report));
    console.info(`Report: ${join(outputDirectory, 'Report.md')}`);
    if (
      !report.hasPairedProjections ||
      !report.matchingConfiguration ||
      !report.matchingPricingSnapshot ||
      !report.matchingStartingState ||
      !report.matchingConfiguredModel ||
      report.matchingReportedModels !== true ||
      !report.matchingSourceHashes ||
      !report.bothSolved
    ) {
      process.exitCode = 1;
    }
  } catch {
    console.error(
      'Observation encoding comparison failed. Check the saved trial artifacts, desktop permissions, scoped credential and options.',
    );
    process.exitCode = 1;
  }
}
