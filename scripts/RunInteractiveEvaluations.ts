import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveConfig } from 'electron-vite';
import electron from 'electron';
import { build } from 'vite';
import { z } from 'zod';
import { ModelCredentialSchema, type ModelCredential } from '../src/contracts/AuthSession.js';
import {
  InteractiveEvaluationLimits,
  InteractiveEvaluationConfigSchema,
  InteractiveRunMode,
  createInteractiveTrialPlan,
  parseInteractiveEvaluationOptions,
  type InteractiveEvaluationOptions,
} from '../test/evaluation/interactive/InteractiveEvaluationConfig.js';
import { prepareInteractiveDesktopHost } from './PrepareInteractiveDesktopHost.js';
import { readInteractiveEvaluationChildEnv } from './Env.js';
import { InteractiveReportOutcome } from '../test/evaluation/interactive/InteractiveEvaluationReport.js';
import { redactEvaluationText } from '../test/evaluation/interactive/AgentRequestOutput.js';
import { EvaluationApplication } from '../test/evaluation/interactive/EvaluationApplication.js';
import { readEvaluationScenarioFile } from '../test/evaluation/interactive/ReadEvaluationScenarios.js';
import { getDefaultEvaluationScenario } from '../test/evaluation/interactive/ScenarioCatalog.js';
import {
  validateEvaluationScenarios,
  formatEvaluationScenarioValidation,
} from '../test/evaluation/interactive/ValidateEvaluationScenarios.js';

const executeFile = promisify(execFile);
const InteractiveLaunchStage = {
  ARTIFACTS: 'artifacts',
  BUILD: 'build',
  HOST: 'prepare_host',
  RUN: 'run_host',
  COMPLETION: 'read_completion',
  FINISHED: 'finished',
} as const;
const InteractiveLaunchStatus = {
  RUNNING: 'running',
  FAILED: 'failed',
  FINISHED: 'finished',
} as const;

/** Failure diagnostics retain only known classes/codes, never raw child errors,
 * configuration, request text or scoped credentials. */
export function describeInteractiveLaunchFailure(error: unknown): {
  errorType: string;
  errorCode: string | null;
} {
  const allowedTypes = ['Error', 'TypeError', 'SyntaxError', 'ZodError'];
  const allowedCodes = [
    'ENOENT',
    'EACCES',
    'EPERM',
    'ERR_MODULE_NOT_FOUND',
    'ERR_REQUIRE_ASYNC_MODULE',
  ];
  return {
    errorType: error instanceof Error && allowedTypes.includes(error.name) ? error.name : 'unknown',
    errorCode:
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      allowedCodes.includes(error.code)
        ? error.code
        : null,
  };
}
const CompletionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  outcome: z.enum(InteractiveReportOutcome),
  preflightCases: z.number().int().nonnegative(),
  attemptedTrials: z.number().int().nonnegative(),
});

/** Only a short-lived Tro gateway credential enters stdin. It is never written
 * to the run config, command line, environment, profile, report or ordinary logs. */
export async function readInteractiveCredential(
  input: AsyncIterable<unknown>,
): Promise<ModelCredential> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
      throw new Error('invalid_credential_input');
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    bytes += buffer.byteLength;
    if (bytes > InteractiveEvaluationLimits.MAXIMUM_BOOTSTRAP_BYTES) {
      throw new Error('credential_input_too_large');
    }
    chunks.push(buffer);
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const credential = ModelCredentialSchema.parse(raw);
  if (credential.token.startsWith('sk-') || Date.parse(credential.expiresAt) <= Date.now() + 5000) {
    throw new Error('short_lived_gateway_credential_required');
  }
  return credential;
}

async function readRevision(): Promise<string | null> {
  try {
    const revision = await executeFile('git', ['rev-parse', 'HEAD'], {
      timeout: 5000,
      maxBuffer: 1024,
    });
    const changes = await executeFile('git', ['status', '--porcelain'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return `${z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .parse(revision.stdout.trim())}${changes.stdout.trim() ? '-dirty' : ''}`;
  } catch {
    return null;
  }
}

async function buildInteractiveHost(root: string): Promise<void> {
  await writeFile(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  const resolved = await resolveConfig(
    { envFile: false, mode: 'production', logLevel: 'warn' },
    'build',
    'production',
  );
  const main = resolved.config?.main;
  if (!main) {
    throw new Error('desktop_build_config_missing');
  }
  await build({
    ...main,
    configFile: false,
    envFile: false,
    logLevel: 'warn',
    build: {
      ...main.build,
      outDir: join(root, 'main'),
      emptyOutDir: false,
      watch: null,
      lib: {
        entry: {
          RunInteractiveEvaluationApp: resolve(
            'test/evaluation/interactive/RunInteractiveEvaluationApp.ts',
          ),
          RunInteractiveAgentWorker: resolve(
            'test/evaluation/interactive/RunInteractiveAgentWorker.ts',
          ),
        },
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
      },
    },
  });
}

async function prepareInteractiveExecutable(
  root: string,
  live: boolean,
): Promise<{ executable: string; args: string[] }> {
  const selected: unknown = live ? await prepareInteractiveDesktopHost() : electron;
  const executable = z.string().min(1).parse(selected);
  return { executable, args: [join(root, 'main', 'RunInteractiveEvaluationApp.js'), root] };
}

async function launchInteractiveHost(
  executable: string,
  args: string[],
  bootstrap: string,
  timeoutMs: number,
): Promise<number> {
  const child = spawn(executable, args, {
    env: readInteractiveEvaluationChildEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Drain child streams without forwarding native errors or model content into logs.
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.stdin.end(bootstrap);
  const timers: { force: NodeJS.Timeout | null } = { force: null };
  const stop = (): void => {
    child.kill('SIGTERM');
    if (!timers.force) {
      timers.force = setTimeout(() => {
        child.kill('SIGKILL');
      }, 10_000);
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const timeout = setTimeout(stop, timeoutMs);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', () => {
        reject(new Error('interactive_host_launch_failed'));
      });
      child.once('exit', (code) => {
        resolve(code ?? 1);
      });
    });
  } finally {
    clearTimeout(timeout);
    if (timers.force) {
      clearTimeout(timers.force);
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export interface InteractiveEvaluationRunResult {
  outputDirectory: string;
  outcome: z.infer<typeof CompletionSchema>['outcome'];
  preflightCases: number;
  attemptedTrials: number;
  plannedTrials: number;
}

/** Scenario calibration completes before credentials reach a model worker. The
 * checkout-only manifest selects registered fixture/grader data, never commands. */
export async function resolveInteractiveEvaluationScenario(
  options: InteractiveEvaluationOptions,
): Promise<InteractiveEvaluationOptions> {
  const config = InteractiveEvaluationConfigSchema.parse(options.config);
  if (config.application === EvaluationApplication.CONTROLLED) {
    if (options.scenarioFile) {
      throw new Error('scenario_application_required');
    }
    return { ...options, config };
  }
  const definition = options.scenarioFile
    ? await readEvaluationScenarioFile(resolve(options.scenarioFile))
    : (config.evaluationScenario ?? getDefaultEvaluationScenario(config.application));
  const validated = InteractiveEvaluationConfigSchema.parse({
    ...config,
    evaluationScenario: definition,
  });
  if (!validateEvaluationScenarios([definition]).passed) {
    throw new Error('scenario_calibration_failed');
  }
  return { ...options, config: validated };
}

/** Preflight only renders fixtures. Live mode runs the production worker/native
 * path and requires the operator's dedicated desktop plus gateway credential. */
export async function runInteractiveEvaluations(
  optionsInput: InteractiveEvaluationOptions,
  credential: ModelCredential | null,
): Promise<InteractiveEvaluationRunResult> {
  const options = await resolveInteractiveEvaluationScenario(optionsInput);
  const live = options.config.runMode === InteractiveRunMode.LIVE;
  if (live !== (credential !== null)) {
    throw new Error('credential_mode_mismatch');
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TroInteractiveEvaluation-')));
  const outputBase = resolve('.tro-development/evaluations');
  await mkdir(outputBase, { recursive: true, mode: 0o700 });
  const outputDirectory = options.output
    ? resolve(options.output)
    : join(
        outputBase,
        `Interactive-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
      );
  let stage: (typeof InteractiveLaunchStage)[keyof typeof InteractiveLaunchStage] =
    InteractiveLaunchStage.ARTIFACTS;
  const startedAt = performance.now();
  const saveLaunchStatus = async (
    status: (typeof InteractiveLaunchStatus)[keyof typeof InteractiveLaunchStatus],
    error?: unknown,
  ): Promise<void> => {
    await writeFile(
      join(outputDirectory, 'LaunchStatus.json'),
      `${JSON.stringify({ schemaVersion: 1, stage, status, elapsedMs: performance.now() - startedAt, ...(error === undefined ? {} : describeInteractiveLaunchFailure(error)) }, null, 2)}\n`,
      { mode: 0o600 },
    );
  };
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
    console.info(`Interactive evaluation artifacts: ${outputDirectory}`);
    const plan = createInteractiveTrialPlan(options.config);
    const serializeArtifact = (value: unknown): string =>
      `${JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'string' ? redactEvaluationText(entry, credential?.token ?? null) : entry), 2)}\n`;
    await writeFile(join(outputDirectory, 'RunConfig.json'), serializeArtifact(options.config), {
      mode: 0o600,
    });
    await writeFile(join(outputDirectory, 'TrialPlan.json'), serializeArtifact(plan), {
      mode: 0o600,
    });
    if (options.config.evaluationScenario) {
      const calibration = validateEvaluationScenarios([options.config.evaluationScenario]);
      await writeFile(
        join(outputDirectory, 'Scenario.json'),
        serializeArtifact(options.config.evaluationScenario),
        { mode: 0o600 },
      );
      await writeFile(
        join(outputDirectory, 'ScenarioValidation.json'),
        serializeArtifact(calibration),
        { mode: 0o600 },
      );
      await writeFile(
        join(outputDirectory, 'ScenarioValidation.md'),
        formatEvaluationScenarioValidation(calibration),
        { mode: 0o600 },
      );
    }
    stage = InteractiveLaunchStage.BUILD;
    await saveLaunchStatus(InteractiveLaunchStatus.RUNNING);
    await buildInteractiveHost(root);
    stage = InteractiveLaunchStage.HOST;
    await saveLaunchStatus(InteractiveLaunchStatus.RUNNING);
    const host = await prepareInteractiveExecutable(root, live);
    const bootstrap = JSON.stringify({
      config: options.config,
      outputDirectory,
      applicationRevision: await readRevision(),
      workerEntry: join(root, 'main', 'RunInteractiveAgentWorker.js'),
      credential,
    });
    stage = InteractiveLaunchStage.RUN;
    await saveLaunchStatus(InteractiveLaunchStatus.RUNNING);
    const setupAllowanceMs =
      options.config.application !== EvaluationApplication.CONTROLLED
        ? InteractiveEvaluationLimits.APPLICATION_SETUP_MS
        : 0;
    const caseCount = new Set(plan.map((trial) => trial.caseId)).size;
    const exitCode = await launchInteractiveHost(
      host.executable,
      host.args,
      bootstrap,
      live
        ? caseCount * setupAllowanceMs +
            plan.length * (InteractiveEvaluationLimits.TRIAL_MS + setupAllowanceMs + 30_000) +
            60_000
        : caseCount * setupAllowanceMs + 60_000,
    );
    if (options.config.singleRequest) {
      try {
        console.info(await readFile(join(outputDirectory, 'Checklist.md'), 'utf8'));
      } catch {
        console.info('Checklist unavailable: the evaluation host did not finish recording.');
      }
    }
    stage = InteractiveLaunchStage.COMPLETION;
    await saveLaunchStatus(InteractiveLaunchStatus.RUNNING);
    const raw: unknown = JSON.parse(await readFile(join(root, 'Completion.json'), 'utf8'));
    const result = CompletionSchema.parse(raw);
    if (exitCode !== 0 || result.outcome === InteractiveReportOutcome.INCOMPLETE) {
      throw new Error('interactive_run_incomplete');
    }
    const expectedCases = new Set(plan.map((trial) => trial.caseId)).size;
    if (
      result.preflightCases !== expectedCases ||
      (live && result.attemptedTrials !== plan.length) ||
      (!live && result.attemptedTrials !== 0)
    ) {
      throw new Error('interactive_completion_mismatch');
    }
    stage = InteractiveLaunchStage.FINISHED;
    await saveLaunchStatus(InteractiveLaunchStatus.FINISHED);
    return { outputDirectory, ...result, plannedTrials: plan.length };
  } catch (error) {
    await saveLaunchStatus(InteractiveLaunchStatus.FAILED, error).catch(() => {});
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  let output: string | undefined;
  try {
    const options = parseInteractiveEvaluationOptions(process.argv.slice(2));
    output = options.output;
    const credential = options.credentialStdin
      ? await readInteractiveCredential(process.stdin)
      : null;
    const result = await runInteractiveEvaluations(options, credential);
    console.info(
      `Interactive evaluation: ${result.outcome}; ${String(result.preflightCases)} setup cases; ${String(result.attemptedTrials)}/${String(result.plannedTrials)} live trials.`,
    );
    console.info(`Report: ${join(result.outputDirectory, 'Report.md')}`);
  } catch {
    console.error(
      'Interactive evaluation failed. Check desktop prerequisites, scoped credential, options and the generated report.',
    );
    if (output) {
      console.info(`Requested output: ${resolve(output)}`);
    }
    process.exitCode = 1;
  }
}
