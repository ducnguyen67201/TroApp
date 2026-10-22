import {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { gradeAgentRequest, formatAgentRequestChecklist } from './GradeAgentRequest.js';
import { AgentRequestRecorder } from './RecordAgentRequest.js';
import { redactEvaluationText } from './AgentRequestOutput.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import { ScratchWorkspaceFailure } from './ScratchWorkspace.js';
import { VisualStudioCodeWorkspaceFailure } from './VisualStudioCodeWorkspace.js';
import { createApplicationAdapter, type ApplicationAdapter } from './ApplicationAdapter.js';
import {
  prepareEvaluationTrial,
  finalizeEvaluationTrial,
  runEvaluationStage,
  EvaluationPipelineStage,
  EvaluationPipelineStatus,
  type EvaluationPipelineEvent,
  type EvaluationPipelineRecorder,
} from './RunEvaluationTrial.js';
import { waitForEvaluationWindow, EvaluationWindowFailure } from './WaitForEvaluationWindow.js';
import { ModelCredentialSchema } from '../../../src/contracts/AuthSession.js';
import { ModelProfile } from '../../../src/contracts/ModelProfile.js';
import { EmbeddedDesktopDriver } from '../../../src/desktop/main/EmbeddedDesktopDriver.js';
import { DesktopPermissions } from '../../../src/desktop/main/DesktopPermissions.js';
import { DesktopPermissionState } from '../../../src/contracts/DesktopPermissions.js';
import {
  InteractiveAgentMessageKind,
  InteractiveAgentResponseSchema,
  InteractiveAgentRunSchema,
  type InteractiveAgentSettled,
} from './InteractiveAgentProtocol.js';
import {
  InteractiveEvaluationConfigSchema,
  InteractiveEvaluationLimits,
  InteractiveRunMode,
  InteractiveVariant,
  createInteractiveTrialPlan,
  type InteractiveTrialPlan,
} from './InteractiveEvaluationConfig.js';
import {
  InteractiveTrialStatus,
  InteractiveReportOutcome,
  formatInteractiveEvaluationReport,
  summarizeInteractiveAgent,
  summarizeInteractiveAccounting,
  summarizeInteractiveResults,
  type InteractiveEvaluationReport,
  type InteractiveTrialResult,
} from './InteractiveEvaluationReport.js';
import { summarizeEvaluationUsage } from '../accounting/EvaluationUsage.js';
import {
  WorkspaceStateSchema,
  createInteractiveCases,
  createWorkspaceHtml,
  gradeWorkspaceOutcome,
  readWorkspaceStateScript,
  type WorkspaceState,
  type WorkspaceOutcomeGrade,
} from './InteractiveStudyWorkspace.js';

const LaunchSchema = z.strictObject({
  config: InteractiveEvaluationConfigSchema,
  outputDirectory: z.string().min(1),
  applicationRevision: z.string().nullable(),
  workerEntry: z.string().min(1),
  credential: ModelCredentialSchema.nullable(),
});

const root = z.string().min(1).parse(process.argv[2]);
app.setPath('userData', join(root, 'Profile'));
app.setPath('sessionData', join(root, 'Profile'));
let window: BrowserWindow | null = null;
let child: UtilityProcess | null = null;
let interrupted = false;
let cancelTrial: (() => void) | null = null;
const workspaceCancellation = new AbortController();
const driver = new EmbeddedDesktopDriver();
let applicationAdapter: ApplicationAdapter | null = null;
let activeTrialId: string | null = null;
let artifactDirectory = root;
const pipelineEvents = new Map<string, EvaluationPipelineEvent[]>();

function createPipelineRecorder(trialId: string): EvaluationPipelineRecorder {
  return async (event) => {
    const events = pipelineEvents.get(trialId) ?? [];
    if (events.length >= 32) {
      throw new Error('evaluation_pipeline_recording_overflow');
    }
    events.push(event);
    pipelineEvents.set(trialId, events);
    await writeFile(
      join(artifactDirectory, `Pipeline-${trialId}.json`),
      JSON.stringify({ schemaVersion: 1, trialId, internalOnly: true, events }, null, 2) + '\n',
      { mode: 0o600 },
    );
  };
}

function cancelEvaluation(): void {
  interrupted = true;
  workspaceCancellation.abort();
  cancelTrial?.();
}

/** Signals and worker callbacks can change this flag across every await. */
function hasInterrupted(): boolean {
  return interrupted;
}

async function readBootstrap(): Promise<z.infer<typeof LaunchSchema>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) {
      throw new Error('invalid_bootstrap');
    }
    bytes += value.byteLength;
    if (bytes > 64 * 1024) {
      throw new Error('oversized_bootstrap');
    }
    chunks.push(value);
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return LaunchSchema.parse(raw);
}

async function readWorkspace(): Promise<WorkspaceState> {
  if (applicationAdapter) {
    return applicationAdapter.observe();
  }
  if (!window || window.isDestroyed()) {
    throw new Error('workspace_closed');
  }
  const raw: unknown = await window.webContents.executeJavaScript(readWorkspaceStateScript);
  return WorkspaceStateSchema.parse(raw);
}

async function resetWorkspace(plan: InteractiveTrialPlan, trialId: string): Promise<void> {
  if (applicationAdapter && plan.evaluationScenario) {
    activeTrialId = trialId;
    await prepareEvaluationTrial(
      applicationAdapter,
      plan.evaluationScenario,
      trialId,
      createPipelineRecorder(trialId),
    );
    return;
  }
  if (!window) {
    throw new Error('workspace_missing');
  }
  const file = join(root, 'Workspace.html');
  await writeFile(file, createWorkspaceHtml({ taskId: plan.scenario.id, trialId }), {
    mode: 0o600,
  });
  await window.loadURL(pathToFileURL(file).href);
  const state = await readWorkspace();
  if (state.taskId !== plan.scenario.id || state.trialId !== trialId) {
    throw new Error('workspace_reset_mismatch');
  }
}

function gradeCurrentWorkspace(
  plan: InteractiveTrialPlan,
  state: WorkspaceState,
  trialId: string,
): WorkspaceOutcomeGrade {
  return applicationAdapter
    ? applicationAdapter.grade(state, trialId)
    : gradeWorkspaceOutcome(plan.scenario, state, trialId);
}

async function saveReport(report: InteractiveEvaluationReport, directory: string): Promise<void> {
  report.accounting = summarizeInteractiveAccounting(report);
  report.usageByVariant = summarizeInteractiveResults(report).map(({ variant, accounting }) => ({
    variant,
    accounting,
  }));
  for (const trial of report.trials) {
    trial.accounting = summarizeEvaluationUsage(
      trial.agent?.modelRequests ?? null,
      report.config.pricing,
    );
  }
  const json = join(directory, 'Report.json');
  await writeFile(`${json}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(`${json}.tmp`, json);
  const markdown = join(directory, 'Report.md');
  const checklist = report.config.singleRequest
    ? (report.trials.at(-1)?.requestEvaluation ??
      gradeAgentRequest({
        trial: null,
        taskMode: report.config.taskMode,
        observations: [],
        traceComplete: false,
        observedOutcomeMatches: null,
        ...(report.config.pricing ? { pricing: report.config.pricing } : {}),
      }))
    : null;
  const formattedChecklist = checklist ? formatAgentRequestChecklist(checklist) : null;
  const request = report.config.singleRequest
    ? (report.config.request ??
      report.config.evaluationScenario?.request ??
      createInteractiveCases(1).find((scenario) => scenario.id === report.config.tasks[0])
        ?.request ??
      null)
    : null;
  const lastTrial = report.trials.at(-1);
  const programArtifactLinks =
    lastTrial && report.config.application === EvaluationApplication.VSCODE
      ? `\n[Authored case](VSCode-${lastTrial.trialId}/Scenario.json) · [Saved-program checks](VSCode-${lastTrial.trialId}/ProgramOutcome.md)\n`
      : '';
  const artifactLinks = lastTrial
    ? `\n[Actual request](Trial-${lastTrial.trialId}/Request.json) · [Public outputs](Trial-${lastTrial.trialId}/Outputs.md) · [Event recording](Trial-${lastTrial.trialId}/Events.jsonl)\n[Pipeline stages](Pipeline-${lastTrial.trialId}.json)\n${programArtifactLinks}`
    : activeTrialId
      ? `\n[Setup pipeline stages](Pipeline-${activeTrialId}.json)\n`
      : '';
  const pipelineTrialId = lastTrial?.trialId ?? activeTrialId;
  const stages = pipelineTrialId ? (pipelineEvents.get(pipelineTrialId) ?? []) : [];
  const stageReport = stages.length
    ? [
        '## Internal pipeline stages',
        '',
        '| Stage | Result | Duration (ms) |',
        '| --- | --- | ---: |',
        ...stages.map(
          (event) =>
            `| ${event.stage} | ${event.status.toUpperCase()} | ${String(Math.round(event.elapsedMs))} |`,
        ),
        '',
      ].join('\n')
    : '';
  await writeFile(
    `${markdown}.tmp`,
    `${formatInteractiveEvaluationReport(report)}\n${stageReport}${formattedChecklist ? `\n## Single request checklist\n\nRequest: ${JSON.stringify(request)}\n\n${formattedChecklist}\n${artifactLinks}` : ''}`,
    { mode: 0o600 },
  );
  await rename(`${markdown}.tmp`, markdown);
  if (formattedChecklist) {
    await writeFile(join(directory, 'Checklist.md'), `${formattedChecklist}\n`, { mode: 0o600 });
  }
}

async function retireWorker(
  worker: UtilityProcess,
  trialId: string,
  exited: Promise<void>,
  alreadySettled: boolean,
): Promise<void> {
  if (child !== worker) {
    return;
  }
  if (alreadySettled) {
    worker.kill();
  }
  try {
    worker.postMessage({ kind: InteractiveAgentMessageKind.CANCEL, trialId });
  } catch {
    /* An exited child cannot receive cancellation. */
  }
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(InteractiveEvaluationLimits.STOP_MS).then(() => false),
  ]);
  if (!stopped) {
    worker.kill();
    const killed = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
    if (!killed) {
      await driver.stop();
      throw new Error('worker_exit_unconfirmed');
    }
  }
  if (child === worker) {
    child = null;
  }
}

async function runTrial(
  plan: InteractiveTrialPlan,
  launch: z.infer<typeof LaunchSchema>,
  recordAttempt: (trial: InteractiveTrialResult) => void,
): Promise<InteractiveTrialResult> {
  if (hasInterrupted()) {
    throw new Error('evaluation_cancelled');
  }
  if (!launch.credential || Date.parse(launch.credential.expiresAt) <= Date.now() + 5000) {
    throw new Error('credential_required_or_expired');
  }
  const trialId = randomUUID();
  await resetWorkspace(plan, trialId);
  if (hasInterrupted()) {
    throw new Error('evaluation_cancelled');
  }
  if (applicationAdapter?.application !== EvaluationApplication.VSCODE) {
    window?.show();
    window?.focus();
  }
  const connection = await runEvaluationStage(
    EvaluationPipelineStage.NATIVE_READY,
    async () => {
      if ((await new DesktopPermissions().readStatus()).kind !== DesktopPermissionState.READY) {
        throw new Error('desktop_permissions_missing');
      }
      if (hasInterrupted()) {
        throw new Error('evaluation_cancelled');
      }
      const nativeConnection = await driver.start(cancelEvaluation);
      const nativeTarget = applicationAdapter?.getNativeTarget();
      if (applicationAdapter?.application === EvaluationApplication.VSCODE && !nativeTarget) {
        throw new Error('evaluation_owned_window_missing');
      }
      if (nativeTarget) {
        const readiness = await waitForEvaluationWindow(
          nativeConnection,
          nativeTarget,
          workspaceCancellation.signal,
        );
        await writeFile(
          join(artifactDirectory, `Readiness-${trialId}.json`),
          JSON.stringify(readiness, null, 2) + '\n',
          { mode: 0o600 },
        );
      }
      if (hasInterrupted()) {
        throw new Error('evaluation_cancelled');
      }
      return nativeConnection;
    },
    createPipelineRecorder(trialId),
  );
  const worker = utilityProcess.fork(launch.workerEntry, [], {
    serviceName: 'Tro interactive evaluation',
  });
  child = worker;
  let settled: InteractiveAgentSettled | null = null;
  let cueAcknowledgedMs: number | null = null;
  let workerExited = false;
  const readSettled = (): InteractiveAgentSettled | null => settled;
  const hasWorkerExited = (): boolean => workerExited;
  const exited = new Promise<void>((resolve) => {
    worker.once('exit', () => {
      workerExited = true;
      resolve();
    });
  });
  let startedAt = performance.now();
  let receive: ((message: unknown) => void) | null = null;
  let recorder: AgentRequestRecorder | null = null;
  let trial: InteractiveTrialResult | null = null;
  let observedOutcomeMatches: boolean | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('worker_start_failed'));
      }, 10_000);
      worker.once('spawn', () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('worker_start_failed'));
      });
    });
    if (hasInterrupted()) {
      throw new Error('evaluation_cancelled');
    }
    recorder = await AgentRequestRecorder.create(
      join(launch.outputDirectory, `Trial-${trialId}`),
      trialId,
      plan.scenario.request,
      launch.credential.token,
    );
    startedAt = performance.now();
    const initialCursor = screen.getCursorScreenPoint();
    let maximumCursorDistanceDip = 0;
    let firstObservedInputMs: number | null = null;
    let firstVerifiedOutcomeMs: number | null = null;
    let timedOut = false;
    let cancelled = false;
    const isTrialCancelled = (): boolean => cancelled;
    receive = (message: unknown): void => {
      const parsed = InteractiveAgentResponseSchema.safeParse(message);
      if (!parsed.success) {
        recorder?.recordRejectedOutput();
        return;
      }
      if (parsed.data.trialId !== trialId) {
        return;
      }
      if (parsed.data.kind === InteractiveAgentMessageKind.CUE_INSTALLED) {
        // Main's receipt span avoids subtracting clocks in different processes.
        cueAcknowledgedMs ??= performance.now() - startedAt;
      } else if (parsed.data.kind === InteractiveAgentMessageKind.OUTPUT) {
        recorder?.appendWorkerOutput(parsed.data, performance.now() - startedAt);
      } else {
        settled = parsed.data;
      }
    };
    worker.on('message', receive);
    cancelTrial = () => {
      cancelled = true;
      try {
        worker.postMessage({ kind: InteractiveAgentMessageKind.CANCEL, trialId });
      } catch {
        /* Child already exited. */
      }
    };
    if (hasInterrupted()) {
      throw new Error('evaluation_cancelled');
    }
    let state = await readWorkspace();
    trial = {
      trialId,
      scenarioId: plan.caseId,
      variant: plan.variant,
      repetition: plan.repetition,
      pairId: plan.pairId,
      startingStateId: plan.startingStateId,
      status: InteractiveTrialStatus.FAILED,
      outcomePassed: false,
      reasons: ['request_did_not_finish'],
      taskDurationMs: 0,
      firstObservedInputMs: null,
      firstVerifiedOutcomeMs: null,
      cueAcknowledgedMs: null,
      cursorMoved: false,
      maximumCursorDistanceDip: 0,
      finalCursorDip: initialCursor,
      observedInput: state.trustedEvents,
      events: state.events,
      geometry: {
        viewport: state.viewport,
        targets: state.targets,
        lastPointerCss: state.lastPointer,
        windowContentDip: window?.getContentBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
      },
      agent: null,
    };
    recordAttempt(trial);
    worker.postMessage(
      InteractiveAgentRunSchema.parse({
        kind: InteractiveAgentMessageKind.RUN,
        trialId,
        desktopDriver: connection,
        credential: launch.credential,
        gatewayBaseUrl: launch.config.gatewayBaseUrl,
        request: plan.scenario.request,
        historyText: plan.scenario.historyText,
        contextEnabled: plan.variant === InteractiveVariant.ON,
        taskMode: launch.config.taskMode,
        locale: plan.scenario.locale,
      }),
    );
    recorder.appendWorkspace(state, performance.now() - startedAt);
    while (!readSettled() && !hasWorkerExited() && !isTrialCancelled() && !hasInterrupted()) {
      if (performance.now() - startedAt >= InteractiveEvaluationLimits.TRIAL_MS) {
        timedOut = true;
        break;
      }
      state = await readWorkspace();
      recorder.appendWorkspace(state, performance.now() - startedAt);
      if (Object.values(state.trustedEvents).some((count) => count > 0)) {
        firstObservedInputMs ??= performance.now() - startedAt;
      }
      if (gradeCurrentWorkspace(plan, state, trialId).passed) {
        firstVerifiedOutcomeMs ??= performance.now() - startedAt;
      }
      const cursor = screen.getCursorScreenPoint();
      maximumCursorDistanceDip = Math.max(
        maximumCursorDistanceDip,
        Math.hypot(cursor.x - initialCursor.x, cursor.y - initialCursor.y),
      );
      await delay(InteractiveEvaluationLimits.POLL_MS);
    }
    state = await readWorkspace();
    recorder.appendWorkspace(state, performance.now() - startedAt);
    if (Object.values(state.trustedEvents).some((count) => count > 0)) {
      firstObservedInputMs ??= performance.now() - startedAt;
    }
    const finalCursor = screen.getCursorScreenPoint();
    maximumCursorDistanceDip = Math.max(
      maximumCursorDistanceDip,
      Math.hypot(finalCursor.x - initialCursor.x, finalCursor.y - initialCursor.y),
    );
    const grade = gradeCurrentWorkspace(plan, state, trialId);
    observedOutcomeMatches =
      state.trialId === trialId && state.taskId === plan.scenario.id ? grade.outcomeMatches : null;
    if (grade.passed) {
      firstVerifiedOutcomeMs ??= performance.now() - startedAt;
    }
    const response = InteractiveAgentResponseSchema.safeParse(readSettled());
    const agent =
      response.success && response.data.kind === InteractiveAgentMessageKind.SETTLED
        ? response.data
        : null;
    const wasCancelled = isTrialCancelled() || hasInterrupted();
    const status = wasCancelled
      ? InteractiveTrialStatus.CANCELLED
      : timedOut
        ? InteractiveTrialStatus.TIMED_OUT
        : !agent || agent.failed
          ? InteractiveTrialStatus.FAILED
          : InteractiveTrialStatus.SETTLED;
    Object.assign(trial, {
      trialId,
      scenarioId: plan.caseId,
      variant: plan.variant,
      repetition: plan.repetition,
      pairId: plan.pairId,
      startingStateId: plan.startingStateId,
      status,
      outcomePassed: grade.passed,
      reasons: grade.reasons,
      taskDurationMs: performance.now() - startedAt,
      firstObservedInputMs,
      firstVerifiedOutcomeMs,
      cueAcknowledgedMs,
      cursorMoved: maximumCursorDistanceDip > 2,
      maximumCursorDistanceDip,
      finalCursorDip: finalCursor,
      observedInput: state.trustedEvents,
      events: state.events,
      geometry: {
        viewport: state.viewport,
        targets: state.targets,
        lastPointerCss: state.lastPointer,
        windowContentDip: window?.getContentBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
      },
      agent: agent ? summarizeInteractiveAgent(agent) : null,
    });
    return trial;
  } catch (error) {
    if (!trial) {
      throw error;
    }
    trial.status = hasInterrupted()
      ? InteractiveTrialStatus.CANCELLED
      : InteractiveTrialStatus.FAILED;
    trial.reasons = ['request_or_workspace_observation_failed'];
    trial.taskDurationMs = performance.now() - startedAt;
    observedOutcomeMatches = null;
    recorder?.recordRejectedOutput();
    return trial;
  } finally {
    cancelTrial = null;
    try {
      const agentElapsedMs = Math.max(0, performance.now() - startedAt);
      await retireWorker(worker, trialId, exited, readSettled() !== null || hasWorkerExited());
      if (trial) {
        await createPipelineRecorder(trialId)({
          stage: EvaluationPipelineStage.AGENT,
          status:
            trial.status === InteractiveTrialStatus.SETTLED
              ? EvaluationPipelineStatus.PASSED
              : EvaluationPipelineStatus.FAILED,
          elapsedMs: agentElapsedMs,
        });
      }
      const terminalAgent = readSettled();
      if (trial && terminalAgent) {
        trial.agent = summarizeInteractiveAgent(terminalAgent);
      }
      if (recorder) {
        try {
          const finalState =
            applicationAdapter && !hasInterrupted()
              ? await finalizeEvaluationTrial(
                  applicationAdapter,
                  trialId,
                  createPipelineRecorder(trialId),
                )
              : await readWorkspace();
          recorder.appendWorkspace(finalState, performance.now() - startedAt);
          const finalGrade = gradeCurrentWorkspace(plan, finalState, trialId);
          observedOutcomeMatches =
            !hasInterrupted() &&
            finalState.trialId === trialId &&
            finalState.taskId === plan.scenario.id
              ? finalGrade.outcomeMatches
              : null;
          if (trial) {
            trial.outcomePassed = !hasInterrupted() && finalGrade.passed;
            trial.reasons = hasInterrupted() ? ['evaluation_cancelled'] : finalGrade.reasons;
            if (trial.outcomePassed) {
              trial.firstVerifiedOutcomeMs ??= performance.now() - startedAt;
            }
            trial.taskDurationMs = performance.now() - startedAt;
          }
        } catch {
          recorder.recordRejectedOutput();
          observedOutcomeMatches = null;
          if (trial) {
            trial.outcomePassed = false;
            trial.reasons = [
              hasInterrupted() ? 'evaluation_cancelled' : 'final_workspace_verification_failed',
            ];
          }
        }
      }
    } finally {
      if (receive) {
        worker.off('message', receive);
      }
      if (recorder) {
        if (trial && hasInterrupted()) {
          trial.status = InteractiveTrialStatus.CANCELLED;
        }
        const summary = await recorder.finish(readSettled()?.outputCount ?? null);
        const canonicalRequest = createInteractiveTrialPlan({
          ...launch.config,
          request: null,
        }).find((item) => item.scenario.id === plan.scenario.id)?.scenario.request;
        const checklist = gradeAgentRequest({
          trial,
          taskMode: launch.config.taskMode,
          observations: recorder.readTeachingObservations(),
          traceComplete: summary.traceComplete,
          observedOutcomeMatches,
          ...(launch.config.pricing ? { pricing: launch.config.pricing } : {}),
          hasApplicableOutcome: canonicalRequest === plan.scenario.request,
          supportsObservedOutcome:
            !hasInterrupted() && (applicationAdapter?.supportsOutcome() ?? true),
        });
        summary.traceComplete = checklist.coverage.complete;
        if (trial) {
          trial.requestEvaluation = checklist;
          trial.recording = summary;
        }
        await recorder.saveEvaluation(checklist, summary);
      }
    }
  }
}

async function runBenchmark(): Promise<void> {
  const launch = await readBootstrap();
  artifactDirectory = launch.outputDirectory;
  const plan = createInteractiveTrialPlan(launch.config);
  const report: InteractiveEvaluationReport = {
    schemaVersion: 1,
    runMode: launch.config.runMode,
    config: {
      ...launch.config,
      request:
        launch.config.request === null
          ? null
          : redactEvaluationText(launch.config.request, launch.credential?.token ?? null),
    },
    model: ModelProfile.MAIN,
    generatedAt: new Date().toISOString(),
    applicationRevision: launch.applicationRevision,
    expectedTrials: plan.length,
    trials: [],
    preflight: [],
    interrupted: false,
    stopReason: null,
    outcome: InteractiveReportOutcome.INCOMPLETE,
    audioLatencyMeasured: false,
    visiblePixelsVerified: false,
    studentLearningMeasured: false,
    contextSource: 'authored_fixture',
    providerAttemptAccountingComplete: false,
  };
  await app.whenReady();
  window = new BrowserWindow({
    width: 1120,
    height: 820,
    show: false,
    title: 'Tro evaluation workspace',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  if (launch.config.application === EvaluationApplication.SCRATCH) {
    applicationAdapter = createApplicationAdapter({
      application: EvaluationApplication.SCRATCH,
      window,
      root: launch.outputDirectory,
      signal: workspaceCancellation.signal,
    });
    window.show();
  }
  if (launch.config.application === EvaluationApplication.VSCODE) {
    applicationAdapter = createApplicationAdapter({
      application: EvaluationApplication.VSCODE,
      root: launch.outputDirectory,
      signal: workspaceCancellation.signal,
    });
  }
  window.on('close', cancelEvaluation);
  let canCancelWithEscape = true;
  if (launch.config.runMode === InteractiveRunMode.LIVE) {
    if (applicationAdapter?.application !== EvaluationApplication.VSCODE) {
      window.setFullScreen(true);
    }
    canCancelWithEscape = globalShortcut.register('Escape', cancelEvaluation);
  }
  process.once('SIGTERM', cancelEvaluation);
  process.once('SIGINT', cancelEvaluation);
  try {
    if (!canCancelWithEscape) {
      throw new Error('cancel_shortcut_unavailable');
    }
    const seen = new Set<string>();
    for (const trial of plan) {
      if (hasInterrupted()) {
        throw new Error('evaluation_cancelled');
      }
      if (seen.has(trial.caseId)) {
        continue;
      }
      seen.add(trial.caseId);
      const trialId = randomUUID();
      await resetWorkspace(trial, trialId);
      const state = await readWorkspace();
      if (hasInterrupted()) {
        throw new Error('evaluation_cancelled');
      }
      const grade = gradeCurrentWorkspace(trial, state, trialId);
      const visibleTarget = state.targets.some(
        (target) =>
          target.bounds.width > 0 &&
          target.bounds.height > 0 &&
          target.bounds.x < state.viewport.width &&
          target.bounds.y < state.viewport.height &&
          target.bounds.x + target.bounds.width > 0 &&
          target.bounds.y + target.bounds.height > 0,
      );
      const hasValidBaseline =
        applicationAdapter?.application === EvaluationApplication.VSCODE
          ? state.pythonSource !== null && state.pythonSource !== undefined
          : visibleTarget;
      if (!hasValidBaseline || grade.outcomeMatches) {
        throw new Error('invalid_fixture_initial_state');
      }
      report.preflight.push({
        scenarioId: trial.caseId,
        rendered: applicationAdapter?.application !== EvaluationApplication.VSCODE,
        targets: state.targets.length,
        initialOutcomePassed: grade.outcomeMatches,
      });
    }
    if (launch.config.runMode === InteractiveRunMode.PREFLIGHT) {
      await applicationAdapter?.finalize();
      report.outcome = InteractiveReportOutcome.PREFLIGHT_PASSED;
    } else {
      for (const trial of plan) {
        if (hasInterrupted()) {
          break;
        }
        await runTrial(trial, launch, (attempt) => report.trials.push(attempt));
        await saveReport(report, launch.outputDirectory);
        console.info('interactive.trial.settled', {
          scenarioId: trial.caseId,
          variant: trial.variant,
          repetition: trial.repetition,
        });
      }
      report.outcome =
        report.trials.length === plan.length && !hasInterrupted()
          ? InteractiveReportOutcome.FINISHED
          : InteractiveReportOutcome.INCOMPLETE;
    }
  } catch (error) {
    const safeReasons = [
      ...Object.values(ScratchWorkspaceFailure),
      ...Object.values(VisualStudioCodeWorkspaceFailure),
      ...Object.values(EvaluationWindowFailure),
      'evaluation_invalid_starting_state',
      'evaluation_final_state_mismatch',
      'evaluation_owned_window_missing',
      'desktop_permissions_missing',
      'cancel_shortcut_unavailable',
      'evaluation_cancelled',
      'credential_required_or_expired',
      'worker_exit_unconfirmed',
      'invalid_fixture_initial_state',
      'workspace_reset_mismatch',
      'workspace_closed',
    ];
    report.stopReason =
      error instanceof Error && safeReasons.includes(error.message)
        ? error.message
        : 'setup_or_native_execution_failed';
    report.outcome = InteractiveReportOutcome.INCOMPLETE;
  } finally {
    report.interrupted = hasInterrupted();
    child?.kill();
    await driver.stop();
    try {
      if (applicationAdapter && activeTrialId) {
        await runEvaluationStage(
          EvaluationPipelineStage.CLEANUP,
          () => applicationAdapter?.close() ?? Promise.resolve(),
          createPipelineRecorder(activeTrialId),
        );
      }
    } catch {
      report.stopReason = 'application_cleanup_unconfirmed';
      report.outcome = InteractiveReportOutcome.INCOMPLETE;
    }
    globalShortcut.unregisterAll();
    await saveReport(report, launch.outputDirectory);
    await writeFile(
      join(root, 'Completion.json'),
      JSON.stringify({
        schemaVersion: 1,
        outcome: report.outcome,
        preflightCases: report.preflight.length,
        attemptedTrials: report.trials.length,
      }),
      { mode: 0o600 },
    );
    window.destroy();
    window = null;
  }
  app.exit(report.outcome === InteractiveReportOutcome.INCOMPLETE ? 1 : 0);
}

void runBenchmark().catch(async () => {
  await driver.stop().catch(() => {});
  child?.kill();
  await applicationAdapter?.close().catch(() => {});
  console.error('interactive.evaluation.failed', { stage: 'bootstrap_or_cleanup' });
  app.exit(1);
});
