import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ModelCredentialSchema, type ModelCredential } from '#contracts/AuthSession.js';
import { AgentTaskMode, AgentTaskModeSchema } from '#contracts/CursorCompanion.js';
import type { AgentChatAuth } from '../AgentChatPorts.js';
import { readEvaluationChildEnv } from '../Env.js';

export const SignedInEvaluationLimits = {
  RUN_MS: 600_000,
  GRACEFUL_STOP_MS: 15_000,
  FORCE_STOP_MS: 5000,
} as const;

export const SignedInEvaluationFailure = {
  SIGN_IN_REQUIRED: 'evaluation_sign_in_required',
  ACCOUNT_CHANGED: 'evaluation_account_changed',
  CREDENTIAL_UNAVAILABLE: 'evaluation_credential_unavailable',
  LAUNCH_FAILED: 'evaluation_launch_failed',
  CANCELLED: 'evaluation_cancelled',
  TIMED_OUT: 'evaluation_timed_out',
  EXIT_UNCONFIRMED: 'evaluation_exit_unconfirmed',
} as const;

export const SignedInEvaluationApplication = { SCRATCH: 'scratch', VSCODE: 'vscode' } as const;

export type SignedInEvaluationApplication =
  (typeof SignedInEvaluationApplication)[keyof typeof SignedInEvaluationApplication];

const ProcessStopSignal = { TERMINATE: 'SIGTERM', FORCE: 'SIGKILL' } as const;

type ProcessStopSignal = (typeof ProcessStopSignal)[keyof typeof ProcessStopSignal];

export interface EvaluationChildProcess {
  endInput(value: string): void;
  onExit(receive: (code: number | null) => void): () => void;
  onError(receive: () => void): () => void;
  stop(signal: ProcessStopSignal): void;
}

export interface EvaluationProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type EvaluationProcessLauncher = (
  executable: string,
  arguments_: readonly string[],
  options: EvaluationProcessOptions,
) => EvaluationChildProcess;

export interface SignedInEvaluationOptions {
  auth: Pick<AgentChatAuth, 'readSession' | 'fetchModelCredential'>;
  projectDirectory: string;
  executablePath: string;
  gatewayBaseUrl: string;
  application?: SignedInEvaluationApplication;
  taskMode?: AgentTaskMode;
  scenarioFile?: string;
  pricingFile?: string;
  childEnvironment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  launch?: EvaluationProcessLauncher;
}

export interface SignedInEvaluationResult {
  outputDirectory: string;
  exitCode: number | null;
}

function isAllowedGateway(value: string): boolean {
  const url = new URL(value);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal))
  );
}

const LaunchSettingsSchema = z.strictObject({
  projectDirectory: z.string().min(1).refine(isAbsolute),
  executablePath: z.string().min(1).refine(isAbsolute),
  gatewayBaseUrl: z.url().refine(isAllowedGateway),
  application: z.enum(SignedInEvaluationApplication).default(SignedInEvaluationApplication.SCRATCH),
  taskMode: AgentTaskModeSchema.default(AgentTaskMode.TEACH),
  scenarioFile: z.string().min(1).refine(isAbsolute).optional(),
  pricingFile: z.string().min(1).refine(isAbsolute).optional(),
});

/** The fixed checkout CLI owns the evaluation host and its native teardown.
 * No child output is forwarded into app logs or parsed as trusted instructions. */
const launchEvaluationProcess: EvaluationProcessLauncher = (executable, arguments_, options) => {
  const child = spawn(executable, [...arguments_], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  return {
    endInput: (value) => {
      child.stdin.end(value);
    },
    onExit: (receive) => {
      child.on('exit', receive);
      return () => {
        child.off('exit', receive);
      };
    },
    onError: (receive) => {
      child.on('error', receive);
      return () => {
        child.off('error', receive);
      };
    },
    stop: (signal) => {
      child.kill(signal);
    },
  };
};

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error(SignedInEvaluationFailure.CANCELLED);
  }
}

/** Development main calls this only after an explicit user action. The existing
 * AuthClient retains session ownership; only its short-lived scoped credential
 * enters the fixed evaluator's stdin. No cookies, keys or profiles are exported. */
export async function runSignedInEvaluation(
  options: SignedInEvaluationOptions,
): Promise<SignedInEvaluationResult> {
  assertNotCancelled(options.signal);
  const settings = LaunchSettingsSchema.parse({
    projectDirectory: options.projectDirectory,
    executablePath: options.executablePath,
    gatewayBaseUrl: options.gatewayBaseUrl,
    application: options.application,
    taskMode: options.taskMode,
    scenarioFile: options.scenarioFile,
    pricingFile: options.pricingFile,
  });
  const environment = readEvaluationChildEnv(options.childEnvironment);
  const session = await options.auth.readSession();
  assertNotCancelled(options.signal);
  if (session.kind !== 'signed-in') {
    throw new Error(SignedInEvaluationFailure.SIGN_IN_REQUIRED);
  }
  let credential: ModelCredential;
  try {
    credential = ModelCredentialSchema.parse(await options.auth.fetchModelCredential());
  } catch {
    throw new Error(SignedInEvaluationFailure.CREDENTIAL_UNAVAILABLE);
  }
  assertNotCancelled(options.signal);
  if (credential.token.startsWith('sk-') || Date.parse(credential.expiresAt) <= Date.now() + 5000) {
    throw new Error(SignedInEvaluationFailure.CREDENTIAL_UNAVAILABLE);
  }
  const currentSession = await options.auth.readSession();
  assertNotCancelled(options.signal);
  if (currentSession.kind !== 'signed-in' || currentSession.user.id !== session.user.id) {
    throw new Error(SignedInEvaluationFailure.ACCOUNT_CHANGED);
  }
  const outputDirectory = join(
    settings.projectDirectory,
    '.tro-development',
    'evaluations',
    `Interactive-signedin-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
  );
  const arguments_ = [
    join(settings.projectDirectory, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(settings.projectDirectory, 'scripts', 'RunInteractiveEvaluations.ts'),
    '--single',
    '--application',
    settings.application,
    ...(settings.taskMode === AgentTaskMode.EXECUTE ? ['--execute'] : []),
    ...(settings.scenarioFile ? ['--scenario-file', settings.scenarioFile] : []),
    ...(settings.pricingFile ? ['--pricing-file', settings.pricingFile] : []),
    '--live',
    '--dedicated-desktop',
    '--credential-stdin',
    '--gateway',
    settings.gatewayBaseUrl,
    '--output',
    outputDirectory,
  ];
  let child: EvaluationChildProcess;
  try {
    child = (options.launch ?? launchEvaluationProcess)(settings.executablePath, arguments_, {
      cwd: settings.projectDirectory,
      env: environment,
    });
  } catch {
    throw new Error(SignedInEvaluationFailure.LAUNCH_FAILED);
  }
  return new Promise<SignedInEvaluationResult>((resolve, reject) => {
    let finished = false;
    let stopReason: string | null = null;
    const hasStopReason = (): boolean => stopReason !== null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      clearTimeout(deadline);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      if (exitTimer) {
        clearTimeout(exitTimer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      removeExit();
      removeError();
    };
    const finish = (code: number | null, failure: string | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      if (failure) {
        reject(new Error(failure));
      } else {
        resolve({ outputDirectory, exitCode: code });
      }
    };
    const stop = (reason: string): void => {
      if (finished || stopReason) {
        return;
      }
      stopReason = reason;
      forceTimer = setTimeout(() => {
        child.stop(ProcessStopSignal.FORCE);
        if (!finished) {
          exitTimer = setTimeout(() => {
            finish(null, SignedInEvaluationFailure.EXIT_UNCONFIRMED);
          }, SignedInEvaluationLimits.FORCE_STOP_MS);
        }
      }, SignedInEvaluationLimits.GRACEFUL_STOP_MS);
      child.stop(ProcessStopSignal.TERMINATE);
    };
    const onAbort = (): void => {
      stop(SignedInEvaluationFailure.CANCELLED);
    };
    const deadline = setTimeout(() => {
      stop(SignedInEvaluationFailure.TIMED_OUT);
    }, SignedInEvaluationLimits.RUN_MS);
    const removeExit = child.onExit((code) => {
      finish(code, stopReason);
    });
    const removeError = child.onError(() => {
      stop(SignedInEvaluationFailure.LAUNCH_FAILED);
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
    try {
      if (!hasStopReason()) {
        child.endInput(JSON.stringify(credential));
      }
    } catch {
      stop(SignedInEvaluationFailure.LAUNCH_FAILED);
    }
  });
}
