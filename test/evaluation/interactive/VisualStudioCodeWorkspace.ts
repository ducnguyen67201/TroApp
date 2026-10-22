import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readEvaluationApplicationEnv } from '../../../src/desktop/main/Env.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import { EvaluationScenarioSchema, type EvaluationScenario } from './EvaluationScenario.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';
import type { ApplicationNativeTarget } from './ApplicationAdapter.js';
import {
  InteractiveTaskId,
  WorkspaceStateSchema,
  type WorkspaceOutcomeGrade,
  type WorkspaceState,
} from './InteractiveStudyWorkspace.js';
import { PythonDebugCase, gradePythonDebugSource } from './PythonDebugCase.js';

export const VisualStudioCodeWorkspaceFailure = {
  CANCELLED: 'evaluation_cancelled',
  PLATFORM_UNSUPPORTED: 'vscode_platform_unsupported',
  EDITOR_UNAVAILABLE: 'vscode_editor_unavailable',
  EDITOR_CLOSED: 'vscode_editor_closed',
  LAUNCH_FAILED: 'vscode_launch_failed',
  STOP_UNCONFIRMED: 'vscode_stop_unconfirmed',
  TRIAL_INVALID: 'vscode_trial_invalid',
  SOURCE_UNAVAILABLE: 'vscode_source_unavailable',
  SOURCE_TOO_LARGE: 'vscode_source_too_large',
  SOURCE_CHANGED_DURING_READ: 'vscode_source_changed_during_read',
  PROFILE_CLEANUP_FAILED: 'vscode_profile_cleanup_failed',
  SCENARIO_INVALID: 'vscode_scenario_invalid',
} as const;

export const VisualStudioCodeLimits = {
  SOURCE_BYTES: 16 * 1024,
  GRACEFUL_STOP_MS: 5000,
  FORCE_STOP_MS: 2000,
  LIFECYCLE_EVENTS: 16,
} as const;

const VisualStudioCodeExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const TrialIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const StopSignal = { TERMINATE: 'SIGTERM', FORCE: 'SIGKILL' } as const;
type StopSignal = (typeof StopSignal)[keyof typeof StopSignal];

const LifecycleStage = {
  LAUNCHED: 'launched',
  STARTED: 'started',
  STOP_REQUESTED: 'stop_requested',
  TERM_ATTEMPTED: 'term_attempted',
  TERM_RETURNED: 'term_returned',
  GRACEFUL_TIMEOUT: 'graceful_timeout',
  KILL_ATTEMPTED: 'kill_attempted',
  KILL_RETURNED: 'kill_returned',
  FORCE_TIMEOUT: 'force_timeout',
  STOPPED: 'stopped',
  FAILED: 'failed',
} as const;
type LifecycleStage = (typeof LifecycleStage)[keyof typeof LifecycleStage];
const LifecycleCauseCodes = new Set(['ESRCH', 'EPERM', 'EACCES', 'EINVAL', 'ENOENT', 'EBADF']);

export interface VisualStudioCodeProcessSnapshot {
  processId: number | null;
  leaderExited: boolean;
  groupRunning: boolean | null;
  failureCode: string | null;
  causeCode: string | null;
}

interface LifecycleEvent extends VisualStudioCodeProcessSnapshot {
  stage: LifecycleStage;
  elapsedMs: number;
  attemptedSignals: StopSignal[];
}

function readSafeCauseCode(error: unknown): string | null {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    LifecycleCauseCodes.has(error.code)
  ) {
    return error.code;
  }
  if (
    error instanceof Error &&
    error.cause instanceof Error &&
    'code' in error.cause &&
    typeof error.cause.code === 'string' &&
    LifecycleCauseCodes.has(error.cause.code)
  ) {
    return error.cause.code;
  }
  return null;
}

function readSafeFailureCode(error: unknown): string | null {
  return error instanceof Error &&
    Object.values(VisualStudioCodeWorkspaceFailure).some((code) => code === error.message)
    ? error.message
    : error === undefined
      ? null
      : 'unknown';
}

/** The fixed installed application is launched directly so its lifetime remains
 * owned by this harness. No shell CLI can detach it into an unowned app instance. */
export interface VisualStudioCodeProcess {
  started: Promise<void>;
  exited: Promise<void>;
  hasExited(): boolean;
  hasRunningProcesses(): boolean;
  readLifecycleSnapshot(): VisualStudioCodeProcessSnapshot;
  stop(signal: StopSignal): void;
}

export interface VisualStudioCodePorts {
  platform: NodeJS.Platform;
  now(): number;
  checkExecutable(path: string): Promise<void>;
  launch(
    executable: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): VisualStudioCodeProcess;
  environment: NodeJS.ProcessEnv;
}

export interface VisualStudioCodeLaunchPorts {
  spawn(executable: string, arguments_: readonly string[], options: SpawnOptions): ChildProcess;
  signalProcess(processId: number, signal: NodeJS.Signals | number): boolean;
}

export function launchVisualStudioCode(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  ports: VisualStudioCodeLaunchPorts = {
    spawn,
    signalProcess: (processId, signal) => process.kill(processId, signal),
  },
): VisualStudioCodeProcess {
  const child = ports.spawn(executable, [...arguments_], {
    env: environment,
    detached: true,
    stdio: 'ignore',
  });
  let exited = false;
  let groupRetired = false;
  let lastProcessFailure: { failureCode: string | null; causeCode: string | null } = {
    failureCode: null,
    causeCode: null,
  };
  const completion = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', (error) => {
      lastProcessFailure = {
        failureCode: VisualStudioCodeWorkspaceFailure.LAUNCH_FAILED,
        causeCode: readSafeCauseCode(error),
      };
      exited = true;
      resolve();
    });
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => {
      reject(new Error(VisualStudioCodeWorkspaceFailure.LAUNCH_FAILED));
    });
  });
  void started.catch(() => undefined);
  return {
    started,
    exited: completion,
    hasExited: () => exited,
    hasRunningProcesses: () => {
      if (groupRetired || child.pid === undefined) {
        return false;
      }
      try {
        ports.signalProcess(-child.pid, 0);
        return true;
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          groupRetired = true;
          lastProcessFailure = { failureCode: null, causeCode: null };
          return false;
        }
        if (readSafeCauseCode(error) === 'EPERM') {
          // XNU may report EPERM for a group whose last member is exiting but
          // has not yet been reaped. Unknown remains active until ESRCH proves
          // absence; persistent permission failures still exhaust retirement.
          lastProcessFailure = {
            failureCode: VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
            causeCode: 'EPERM',
          };
          return true;
        }
        throw new Error(VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED, { cause: error });
      }
    },
    readLifecycleSnapshot: () => {
      let groupRunning: boolean | null = null;
      let causeCode = lastProcessFailure.causeCode;
      let failureCode = lastProcessFailure.failureCode;
      if (child.pid !== undefined) {
        try {
          ports.signalProcess(-child.pid, 0);
          groupRunning = true;
        } catch (error: unknown) {
          causeCode = readSafeCauseCode(error);
          if (causeCode === 'ESRCH') {
            groupRunning = false;
          } else {
            failureCode = VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED;
          }
        }
      }
      return {
        processId: child.pid ?? null,
        leaderExited: exited,
        groupRunning,
        failureCode,
        causeCode,
      };
    },
    stop: (signal) => {
      // While the owned leader is alive its process-group ID cannot be reused.
      // Never signal an existing user VS Code instance or search by app name.
      if (!exited && !groupRetired && child.pid !== undefined) {
        try {
          ports.signalProcess(-child.pid, signal);
        } catch (error: unknown) {
          const causeCode = readSafeCauseCode(error);
          if (causeCode === 'EPERM') {
            lastProcessFailure = {
              failureCode: VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
              causeCode,
            };
            return;
          }
          if (causeCode !== 'ESRCH') {
            throw new Error(VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED, { cause: error });
          }
        }
      }
    },
  };
}

function createPorts(): VisualStudioCodePorts {
  return {
    platform: process.platform,
    now: () => performance.now(),
    checkExecutable: (path) => access(path, constants.X_OK),
    launch: launchVisualStudioCode,
    // Integration harnesses may forward process environment through the owning
    // validator; provider keys and Electron/Node injection flags are excluded.
    environment: readEvaluationApplicationEnv(process.env),
  };
}

async function waitForRetirement(
  child: VisualStudioCodeProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (!child.hasRunningProcesses()) {
    return true;
  }
  return new Promise<boolean>((resolve, reject) => {
    let poll: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let finished = false;
    const finish = (retired: boolean, failed = false): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (poll) {
        clearInterval(poll);
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      if (failed) {
        reject(new Error(VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED));
      } else {
        resolve(retired);
      }
    };
    const check = (): void => {
      try {
        if (!child.hasRunningProcesses()) {
          finish(true);
        }
      } catch {
        finish(false, true);
      }
    };
    poll = setInterval(check, 25);
    timeout = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    void child.exited.then(check);
    check();
  });
}

function readSourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/** This grade describes saved source, interpreted independently by a bounded
 * exercise-specific evaluator. It does not claim Python execution, native input
 * attribution, visible pixels, or a student's understanding. */
export function gradeVisualStudioCodeState(
  state: WorkspaceState,
  expectedTrialId: string,
): WorkspaceOutcomeGrade {
  const observed = WorkspaceStateSchema.parse(state);
  const matchesTrial =
    observed.application === EvaluationApplication.VSCODE &&
    observed.taskId === InteractiveTaskId.DEBUG_PYTHON &&
    observed.trialId === expectedTrialId;
  const program =
    observed.pythonSource === undefined || observed.pythonSource === null
      ? null
      : gradePythonDebugSource(observed.pythonSource);
  const reasons: string[] = [];
  if (!matchesTrial) {
    reasons.push('vscode_trial_mismatch');
  }
  if (program === null) {
    reasons.push(VisualStudioCodeWorkspaceFailure.SOURCE_UNAVAILABLE);
  } else {
    reasons.push(...program.reasons);
  }
  if (observed.pythonSourceChanged !== true) {
    reasons.push('vscode_source_unchanged');
  }
  const outcomeMatches = matchesTrial && program?.supported === true && program.passed;
  return {
    passed: outcomeMatches && observed.pythonSourceChanged === true,
    outcomeMatches,
    trustedInteractionObserved: false,
    reasons,
  };
}

/** Owns one disposable instance of the real installed macOS VS Code application.
 * Only the authored main.py is observed, on disk after Save. The student's normal
 * profile, extensions, recent files and existing windows are never used. */
export class VisualStudioCodeWorkspace {
  private readonly ports: VisualStudioCodePorts;
  private child: VisualStudioCodeProcess | null = null;
  private closePromise: Promise<void> | null = null;
  private removeAbortListener: (() => void) | null = null;
  private trialId: string | null = null;
  private sourcePath: string | null = null;
  private startedAt = 0;
  private firstEffectElapsedMs: number | null = null;
  private lastEffectElapsedMs: number | null = null;
  private previousSource: string | null = null;
  private outcomeApplicable = false;
  private sourceFailure: string | null = null;
  private lifecycleDirectory: string | null = null;
  private lifecycleEvents: LifecycleEvent[] = [];
  private lifecycleEventsDropped = 0;
  private attemptedSignals: StopSignal[] = [];
  private lifecycleWrites: Promise<void> = Promise.resolve();
  private shortProfileDirectory: string | null = null;
  private startingSource: string = PythonDebugCase.startingSource;

  constructor(
    private readonly root: string,
    private readonly signal?: AbortSignal,
    ports?: VisualStudioCodePorts,
  ) {
    this.ports = ports ?? createPorts();
  }

  async reset(
    trialId: string,
    scenarioInput: EvaluationScenario = getDefaultEvaluationScenario(EvaluationApplication.VSCODE),
  ): Promise<void> {
    this.throwIfCancelled();
    const scenario = EvaluationScenarioSchema.parse(scenarioInput);
    if (scenario.application !== EvaluationApplication.VSCODE) {
      throw new Error(VisualStudioCodeWorkspaceFailure.SCENARIO_INVALID);
    }
    const parsed = TrialIdSchema.safeParse(trialId);
    if (!parsed.success || !isAbsolute(this.root)) {
      throw new Error(VisualStudioCodeWorkspaceFailure.TRIAL_INVALID);
    }
    if (this.ports.platform !== 'darwin') {
      throw new Error(VisualStudioCodeWorkspaceFailure.PLATFORM_UNSUPPORTED);
    }
    await this.close();
    this.closePromise = null;
    this.throwIfCancelled();
    try {
      await this.ports.checkExecutable(VisualStudioCodeExecutable);
    } catch {
      this.throwIfCancelled();
      throw new Error(VisualStudioCodeWorkspaceFailure.EDITOR_UNAVAILABLE);
    }
    this.throwIfCancelled();
    const directory = join(this.root, `VSCode-${parsed.data}`);
    const sourcePath = join(directory, 'main.py');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    // Darwin's Unix-domain IPC path limit is only 103 bytes. The usual macOS
    // temporary directory and artifact path can both exceed it, so this owned
    // random profile deliberately uses the short /tmp prefix instead.
    const profile = await mkdtemp('/tmp/TroCode-');
    this.shortProfileDirectory = profile;
    const extensions = join(profile, 'Extensions');
    try {
      await mkdir(join(profile, 'User'), { recursive: true, mode: 0o700 });
      await mkdir(extensions, { mode: 0o700 });
      this.throwIfCancelled();
      await writeFile(sourcePath, scenario.fixture.source, { flag: 'wx', mode: 0o600 });
      await writeFile(
        join(profile, 'User', 'settings.json'),
        JSON.stringify(
          {
            'workbench.startupEditor': 'none',
            'window.title': `Tro evaluation - ${trialId} - \${activeEditorShort}`,
            'files.autoSave': 'off',
            'editor.tabSize': 4,
            'editor.insertSpaces': true,
            'editor.detectIndentation': false,
            'editor.formatOnSave': false,
            'telemetry.telemetryLevel': 'off',
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      await writeFile(
        join(directory, 'Scenario.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            trialId: parsed.data,
            application: EvaluationApplication.VSCODE,
            purpose: 'canonical_authored_case',
            actualAgentInputFile: `../Trial-${parsed.data}/Request.json`,
            actualAgentInputNote:
              'Live trials record the actual request in that separate file. Preflight has no live agent input; this artifact describes the canonical authored case.',
            scenario: {
              ...scenario,
              startingSource: scenario.fixture.source,
            },
            savedSourceFile: 'main.py',
            sourceObservation:
              'Only saved source is observed; native input and Python execution are unassessed.',
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      this.throwIfCancelled();
      this.trialId = parsed.data;
      this.sourcePath = sourcePath;
      this.startedAt = this.ports.now();
      this.firstEffectElapsedMs = null;
      this.lastEffectElapsedMs = null;
      this.startingSource = scenario.fixture.source;
      this.previousSource = this.startingSource;
      this.sourceFailure = null;
      this.outcomeApplicable = false;
      this.lifecycleDirectory = directory;
      this.lifecycleEvents = [];
      this.lifecycleEventsDropped = 0;
      this.attemptedSignals = [];
      this.lifecycleWrites = Promise.resolve();
      this.child = this.ports.launch(
        VisualStudioCodeExecutable,
        [
          '--user-data-dir',
          profile,
          '--extensions-dir',
          extensions,
          '--disable-extensions',
          '--new-window',
          '--skip-welcome',
          '--skip-release-notes',
          '--goto',
          `${sourcePath}:${String(scenario.fixture.cursor.line)}:${String(scenario.fixture.cursor.column)}`,
        ],
        this.ports.environment,
      );
      this.recordLifecycle(LifecycleStage.LAUNCHED, this.child);
      const abort = (): void => {
        this.outcomeApplicable = false;
        void this.close().catch(() => undefined);
      };
      this.signal?.addEventListener('abort', abort, { once: true });
      this.removeAbortListener = () => this.signal?.removeEventListener('abort', abort);
      try {
        this.throwIfCancelled();
        await this.waitForStartup(this.child);
        this.throwIfCancelled();
        if (this.child.hasExited()) {
          throw new Error(VisualStudioCodeWorkspaceFailure.LAUNCH_FAILED);
        }
        this.recordLifecycle(LifecycleStage.STARTED, this.child);
      } catch {
        await this.close();
        this.throwIfCancelled();
        throw new Error(VisualStudioCodeWorkspaceFailure.LAUNCH_FAILED);
      }
    } catch (error: unknown) {
      if (!this.child) {
        await this.removeShortProfile();
      }
      throw error;
    }
  }

  async readState(): Promise<WorkspaceState> {
    this.throwIfCancelled();
    if (!this.child || this.child.hasExited() || !this.trialId || !this.sourcePath) {
      throw new Error(VisualStudioCodeWorkspaceFailure.EDITOR_CLOSED);
    }
    const source = await this.readSavedSource(this.sourcePath);
    this.throwIfCancelled();
    const sourceChanged = source !== null && source !== this.startingSource;
    if (source !== this.previousSource) {
      const elapsedMs = Math.max(0, this.ports.now() - this.startedAt);
      this.firstEffectElapsedMs ??= elapsedMs;
      this.lastEffectElapsedMs = elapsedMs;
      this.previousSource = source;
    }
    this.outcomeApplicable = source !== null && gradePythonDebugSource(source).supported;
    return WorkspaceStateSchema.parse({
      schemaVersion: 1,
      application: EvaluationApplication.VSCODE,
      taskId: InteractiveTaskId.DEBUG_PYTHON,
      trialId: this.trialId,
      pythonSource: source,
      pythonSourceChanged: sourceChanged,
      pythonDebugged: source !== null && gradePythonDebugSource(source).passed,
      saved: source !== null,
      dropCompleted: false,
      projectTitle: 'main.py',
      scrollConfirmed: false,
      scrollTop: 0,
      repeatCount: null,
      validationVisible: false,
      destination: null,
      trustedEvents: {
        click: 0,
        pointerDown: 0,
        pointerMove: 0,
        pointerUp: 0,
        input: 0,
        keyDown: 0,
        wheel: 0,
        drag: 0,
      },
      lastPointer: null,
      firstEffectElapsedMs: this.firstEffectElapsedMs,
      lastEffectElapsedMs: this.lastEffectElapsedMs,
      // Neutral compatibility fields, never an assertion about editor geometry.
      viewport: { width: 1, height: 1, devicePixelRatio: 1 },
      targets: [],
      events: [],
    });
  }

  gradeState(state: WorkspaceState, expectedTrialId: string): WorkspaceOutcomeGrade {
    this.throwIfCancelled();
    return gradeVisualStudioCodeState(state, expectedTrialId);
  }

  isOutcomeApplicable(): boolean {
    return !this.signal?.aborted && this.outcomeApplicable;
  }

  /** Identifies only the process and document created by this workspace. Native
   * readiness is verified by the composition before it starts the model worker. */
  getNativeTarget(): ApplicationNativeTarget | null {
    const child = this.child;
    if (!child || child.hasExited() || !this.trialId) {
      return null;
    }
    const processId = child.readLifecycleSnapshot().processId;
    return processId === null || !Number.isSafeInteger(processId) || processId <= 0
      ? null
      : { processId, title: `Tro evaluation - ${this.trialId} - main.py`, documentName: 'main.py' };
  }

  async saveOutcome(): Promise<void> {
    const state = await this.readState();
    const program =
      state.pythonSource === null || state.pythonSource === undefined
        ? null
        : gradePythonDebugSource(state.pythonSource);
    const directory = this.sourcePath ? dirname(this.sourcePath) : null;
    if (!directory) {
      throw new Error(VisualStudioCodeWorkspaceFailure.SOURCE_UNAVAILABLE);
    }
    const outcome = {
      schemaVersion: 1,
      trialId: state.trialId,
      application: EvaluationApplication.VSCODE,
      grade: this.gradeState(state, state.trialId),
      source: state.pythonSource ?? null,
      sourceSha256: state.pythonSource ? readSourceHash(state.pythonSource) : null,
      sourceFailure: this.sourceFailure,
      program,
      pythonExecutionMeasured: false,
      physicalStudentInputMeasured: false,
      studentUnderstandingMeasured: false,
    };
    this.throwIfCancelled();
    await writeFile(
      join(directory, 'ProgramOutcome.json'),
      JSON.stringify(outcome, null, 2) + '\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, 'ProgramOutcome.md'),
      [
        '# Saved Python program outcome',
        '',
        `Trial: ${state.trialId}. Saved source changed: ${String(state.pythonSourceChanged === true)}.`,
        '',
        `Independent saved-source outcome: ${outcome.grade.passed ? 'PASS' : program?.supported === false || program === null ? 'UNASSESSED' : 'FAIL'}.`,
        '',
        'The exercise-specific bounded interpreter checks the saved source. Python was not executed. Native input attribution, visible pixels and student understanding are unassessed.',
        '',
        '| Program check | Result |',
        '| --- | --- |',
        ...(program?.milestones.map(
          (milestone) =>
            `| ${milestone.title.replaceAll('|', '\\|')} | ${milestone.status.toUpperCase()} |`,
        ) ?? []),
        '',
        ...(program?.reasons.length ? [`Reasons: ${program.reasons.join(', ')}.`, ''] : []),
        '[Full recorded source, checks and evidence](ProgramOutcome.json)',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const child = this.child;
    this.removeAbortListener?.();
    this.removeAbortListener = null;
    this.outcomeApplicable = false;
    if (!child) {
      await this.removeShortProfile();
      return;
    }
    this.recordLifecycle(LifecycleStage.STOP_REQUESTED, child);
    this.closePromise = (async () => {
      try {
        await this.stopEditor(child);
        await this.removeShortProfile();
      } catch (error: unknown) {
        this.recordLifecycle(LifecycleStage.FAILED, child, error);
        throw error;
      } finally {
        await this.lifecycleWrites;
      }
    })();
    return this.closePromise;
  }

  private async waitForStartup(child: VisualStudioCodeProcess): Promise<void> {
    const signal = this.signal;
    if (!signal) {
      return child.started;
    }
    let removeAbortListener = (): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        reject(new Error(VisualStudioCodeWorkspaceFailure.CANCELLED));
      };
      signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener('abort', abort);
      };
    });
    try {
      this.throwIfCancelled();
      await Promise.race([child.started, cancelled]);
    } finally {
      removeAbortListener();
    }
  }

  private async stopEditor(child: VisualStudioCodeProcess): Promise<void> {
    if (child.hasRunningProcesses()) {
      if (!child.hasExited()) {
        this.attemptedSignals.push(StopSignal.TERMINATE);
        this.recordLifecycle(LifecycleStage.TERM_ATTEMPTED, child);
        child.stop(StopSignal.TERMINATE);
        this.recordLifecycle(LifecycleStage.TERM_RETURNED, child);
      }
      if (!(await waitForRetirement(child, VisualStudioCodeLimits.GRACEFUL_STOP_MS))) {
        this.recordLifecycle(LifecycleStage.GRACEFUL_TIMEOUT, child);
        // A still-running original leader pins the group identity. Once it has
        // exited, observe remaining helpers but never signal a possibly reused
        // group ID. Unknown retirement blocks the next trial instead.
        if (child.hasExited()) {
          throw new Error(VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED);
        }
        this.attemptedSignals.push(StopSignal.FORCE);
        this.recordLifecycle(LifecycleStage.KILL_ATTEMPTED, child);
        child.stop(StopSignal.FORCE);
        this.recordLifecycle(LifecycleStage.KILL_RETURNED, child);
        if (!(await waitForRetirement(child, VisualStudioCodeLimits.FORCE_STOP_MS))) {
          this.recordLifecycle(LifecycleStage.FORCE_TIMEOUT, child);
          throw new Error(VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED);
        }
      }
    }
    this.recordLifecycle(LifecycleStage.STOPPED, child);
    if (this.child === child) {
      this.child = null;
    }
  }

  private async removeShortProfile(): Promise<void> {
    const profile = this.shortProfileDirectory;
    if (!profile) {
      return;
    }
    // This value is assigned only from our own mkdtemp call, never from a CLI,
    // artifact, user path or provider output. Keep a final structural guard on
    // recursive deletion, and preserve the directory if ownership is unclear.
    if (!/^\/tmp\/TroCode-[A-Za-z0-9]+$/.test(profile)) {
      throw new Error(VisualStudioCodeWorkspaceFailure.PROFILE_CLEANUP_FAILED);
    }
    try {
      await rm(profile, { recursive: true, force: true });
      this.shortProfileDirectory = null;
    } catch (error: unknown) {
      throw new Error(VisualStudioCodeWorkspaceFailure.PROFILE_CLEANUP_FAILED, { cause: error });
    }
  }

  private recordLifecycle(
    stage: LifecycleStage,
    child: VisualStudioCodeProcess,
    error?: unknown,
  ): void {
    const directory = this.lifecycleDirectory;
    if (!directory) {
      return;
    }
    let snapshot: VisualStudioCodeProcessSnapshot;
    try {
      snapshot = child.readLifecycleSnapshot();
    } catch (cause: unknown) {
      snapshot = {
        processId: null,
        leaderExited: child.hasExited(),
        groupRunning: null,
        failureCode: VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
        causeCode: readSafeCauseCode(cause),
      };
    }
    const snapshotFailureCode =
      snapshot.failureCode === null ? null : readSafeFailureCode(new Error(snapshot.failureCode));
    const snapshotCauseCode =
      snapshot.causeCode !== null && LifecycleCauseCodes.has(snapshot.causeCode)
        ? snapshot.causeCode
        : null;
    const event: LifecycleEvent = {
      processId:
        Number.isSafeInteger(snapshot.processId) &&
        snapshot.processId !== null &&
        snapshot.processId > 0
          ? snapshot.processId
          : null,
      leaderExited: snapshot.leaderExited,
      groupRunning: snapshot.groupRunning,
      failureCode: readSafeFailureCode(error) ?? snapshotFailureCode,
      causeCode: readSafeCauseCode(error) ?? snapshotCauseCode,
      stage,
      elapsedMs: Math.max(0, this.ports.now() - this.startedAt),
      attemptedSignals: [...this.attemptedSignals],
    };
    if (this.lifecycleEvents.length === VisualStudioCodeLimits.LIFECYCLE_EVENTS) {
      this.lifecycleEvents.shift();
      this.lifecycleEventsDropped += 1;
    }
    this.lifecycleEvents.push(event);
    const artifact =
      JSON.stringify(
        {
          schemaVersion: 1,
          trialId: this.trialId,
          eventsDropped: this.lifecycleEventsDropped,
          events: this.lifecycleEvents,
        },
        null,
        2,
      ) + '\n';
    this.lifecycleWrites = this.lifecycleWrites
      .then(async () => {
        const path = join(directory, 'VSCodeLifecycle.json');
        await writeFile(`${path}.tmp`, artifact, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      })
      .catch(() => undefined);
  }

  private async readSavedSource(path: string): Promise<string | null> {
    this.sourceFailure = null;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > VisualStudioCodeLimits.SOURCE_BYTES) {
          this.sourceFailure =
            before.size > VisualStudioCodeLimits.SOURCE_BYTES
              ? VisualStudioCodeWorkspaceFailure.SOURCE_TOO_LARGE
              : VisualStudioCodeWorkspaceFailure.SOURCE_UNAVAILABLE;
          return null;
        }
        const buffer = Buffer.alloc(VisualStudioCodeLimits.SOURCE_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const after = await file.stat();
        const current = await lstat(path);
        if (bytesRead > VisualStudioCodeLimits.SOURCE_BYTES) {
          this.sourceFailure = VisualStudioCodeWorkspaceFailure.SOURCE_TOO_LARGE;
          return null;
        }
        if (
          before.mtimeMs !== after.mtimeMs ||
          before.size !== after.size ||
          before.ino !== after.ino ||
          !current.isFile() ||
          current.ino !== after.ino ||
          current.dev !== after.dev ||
          current.size !== after.size ||
          current.mtimeMs !== after.mtimeMs
        ) {
          this.sourceFailure = VisualStudioCodeWorkspaceFailure.SOURCE_CHANGED_DURING_READ;
          return null;
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } finally {
        await file.close();
      }
    } catch {
      this.sourceFailure = VisualStudioCodeWorkspaceFailure.SOURCE_UNAVAILABLE;
      return null;
    }
  }

  private throwIfCancelled(): void {
    if (this.signal?.aborted) {
      this.outcomeApplicable = false;
      throw new Error(VisualStudioCodeWorkspaceFailure.CANCELLED);
    }
  }
}
