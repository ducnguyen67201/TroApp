import type { DownloadItem, Event, WebContents } from 'electron';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { EvaluationApplication } from './EvaluationApplication.js';
import { EvaluationScenarioSchema, type EvaluationScenario } from './EvaluationScenario.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';
import {
  InteractiveTaskId,
  WorkspaceEventKind,
  WorkspaceStateSchema,
  type WorkspaceOutcomeGrade,
  type WorkspaceState,
} from './InteractiveStudyWorkspace.js';
import {
  createScratchProjectArchive,
  gradeScratchProject,
  parseScratchProjectArchive,
  ScratchProjectLimits,
  type ScratchProject,
} from './ScratchProject.js';

export const ScratchWorkspaceFailure = {
  CANCELLED: 'evaluation_cancelled',
  PAGE_UNAVAILABLE: 'scratch_page_unavailable',
  EDITOR_UNAVAILABLE: 'scratch_editor_unavailable',
  IMPORT_FAILED: 'scratch_import_failed',
  EXPORT_FAILED: 'scratch_export_failed',
  EXPORT_TOO_LARGE: 'scratch_export_too_large',
  EXPORT_UNSUPPORTED: 'scratch_export_unsupported',
  OBSERVATION_FAILED: 'scratch_observation_failed',
  TRIAL_INVALID: 'scratch_trial_invalid',
  SCENARIO_INVALID: 'scratch_scenario_invalid',
  CLOSED: 'scratch_workspace_closed',
} as const;

type DownloadListener = (event: Event, item: DownloadItem, contents: WebContents) => void;

/** The real BrowserWindow satisfies this narrow port; unit tests need no desktop. */
export interface ScratchBrowserWindow {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  webContents: {
    getURL(): string;
    executeJavaScript(script: string): Promise<unknown>;
    stop(): void;
    session: {
      on(event: 'will-download', listener: DownloadListener): unknown;
      removeListener(event: 'will-download', listener: DownloadListener): unknown;
    };
  };
}

const ScratchWorkspaceLimits = {
  EDITOR_TIMEOUT_MS: 60_000,
  IMPORT_TIMEOUT_MS: 30_000,
  EXPORT_TIMEOUT_MS: 20_000,
  MENU_TIMEOUT_MS: 5_000,
  POLL_INTERVAL_MS: 200,
  MAXIMUM_ARCHIVE_BYTES: ScratchProjectLimits.ARCHIVE_BYTES,
} as const;

const ScratchTargetId = {
  GREEN_FLAG: 'scratch-green-flag',
  BLOCKS: 'scratch-blocks',
  FILE: 'scratch-file',
  SCORE: 'scratch-score',
  OTHER: 'scratch-other',
} as const;

const ScratchEditorUrl = 'https://scratch.mit.edu/projects/editor/';
const TrialIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const ObservationSchema = z.strictObject({
  state: WorkspaceStateSchema,
  inputRevision: z.number().int().nonnegative().max(1_000_000),
});

/* These selectors follow Scratch's public GUI components. The older File/Go
 * markup remains supported because the live site can trail the source release.
 * No store, React object, VM global or candidate-supplied script is inspected. */
const scratchDomHelpersScript = `
  const isVisible = element => {
    if (!(element instanceof Element)) return false;
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const readFileMenu = () => document.querySelector('button[aria-label="File menu"]') ||
    Array.from(document.querySelectorAll('[class*="menu-bar_menu-bar-item"]')).find(element =>
      isVisible(element) && Array.from(element.children).some(child => child.textContent.trim() === 'File')) || null;
  const openFileMenu = menu => {
    if (menu instanceof HTMLButtonElement) menu.click();
    else menu.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
  const readGreenFlag = () => document.querySelector('button[aria-label="Start project"]') ||
    document.querySelector('img[title="Go"]')?.closest('button') ||
    document.querySelector('img[title="Go"]') || null;
  const readBlocks = () => document.querySelector('svg.blocklySvg');
  const readScore = () => {
    const labels = Array.from(document.querySelectorAll('[class*="monitor_label"]')).filter(element =>
      isVisible(element) && element.textContent.trim().toLowerCase() === 'score');
    if (labels.length !== 1) return { value: null, element: null };
    const element = labels[0].parentElement?.querySelector('[class*="monitor_value"]');
    if (!isVisible(element)) return { value: null, element: null };
    const text = element.textContent.trim();
    if (!/^-?\\d+(?:\\.\\d+)?$/.test(text) || text.length > 20) return { value: null, element: null };
    const value = Number(text);
    return { value: Number.isFinite(value) ? value : null, element };
  };
  const readMenuItem = label => Array.from(document.querySelectorAll('li, [role="menuitem"]')).find(element =>
    isVisible(element) && element.textContent.trim() === label) || null;
`;

const readEditorReadyScript = `(() => {
  ${scratchDomHelpersScript}
  return isVisible(readFileMenu()) && isVisible(readGreenFlag()) && isVisible(readBlocks());
})()`;

const openFileMenuScript = `(() => {
  ${scratchDomHelpersScript}
  if (readMenuItem('Load from your computer') && readMenuItem('Save to your computer')) return true;
  const menu = readFileMenu();
  if (!(menu instanceof HTMLElement)) return false;
  openFileMenu(menu);
  return true;
})()`;

const readFileMenuReadyScript = `(() => {
  ${scratchDomHelpersScript}
  return Boolean(readMenuItem('Load from your computer') && readMenuItem('Save to your computer'));
})()`;

function createImportScript(archive: Uint8Array): string {
  return `(() => {
    ${scratchDomHelpersScript}
    const item = readMenuItem('Load from your computer');
    if (!(item instanceof HTMLElement)) return false;
    const originalClick = HTMLInputElement.prototype.click;
    try {
      // The real upload control creates its hidden file input synchronously.
      // Suppress its OS picker only during fixture setup, then restore it.
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') originalClick.call(this);
      };
      item.click();
    } finally {
      HTMLInputElement.prototype.click = originalClick;
    }
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(input =>
      input.accept.split(',').some(extension => extension.trim() === '.sb3'));
    const input = inputs.at(-1);
    if (!(input instanceof HTMLInputElement)) return false;
    const archive = new Uint8Array(${JSON.stringify(Array.from(archive))});
    const transfer = new DataTransfer();
    transfer.items.add(new File([archive], 'ScratchScoreDebug.sb3', { type: 'application/x.scratch.sb3' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

const readImportReadyScript = `(() => {
  ${scratchDomHelpersScript}
  return isVisible(readBlocks()) && readScore().value !== null &&
    !Array.from(document.querySelectorAll('input[type="file"]')).some(input =>
      input.accept.split(',').some(extension => extension.trim() === '.sb3'));
})()`;

function createObservationScript(trialId: string): string {
  return `(() => {
    ${scratchDomHelpersScript}
    const startedAt = performance.now();
    const observed = {
      trialId: ${JSON.stringify(trialId)}, startedAt, inputRevision: 0,
      trustedEvents: { click: 0, pointerDown: 0, pointerMove: 0, pointerUp: 0, input: 0, keyDown: 0, wheel: 0, drag: 0 },
      events: [], lastPointer: null, initialScore: readScore().value,
      firstEffectElapsedMs: null, lastEffectElapsedMs: null, lastScore: readScore().value,
      blockPointerActive: false
    };
    const readTargetId = target => {
      if (!(target instanceof Element)) return '${ScratchTargetId.OTHER}';
      const greenFlag = readGreenFlag();
      if (greenFlag && (greenFlag === target || greenFlag.contains(target))) return '${ScratchTargetId.GREEN_FLAG}';
      if (target.closest('svg.blocklySvg, .blocklyWorkspace, .blocklyDraggable, [class*="blocklyWidgetDiv"], [class*="blocklyDropDownDiv"]')) return '${ScratchTargetId.BLOCKS}';
      const fileMenu = readFileMenu();
      if ((fileMenu && fileMenu.contains(target)) || target.closest('[data-menu-item="true"]')) return '${ScratchTargetId.FILE}';
      return '${ScratchTargetId.OTHER}';
    };
    const record = (event, kind) => {
      const trusted = event.isTrusted === true;
      let targetId = readTargetId(event.target);
      if (trusted && kind === 'pointerDown') observed.blockPointerActive = targetId === '${ScratchTargetId.BLOCKS}';
      // Blockly may release pointer capture outside the SVG. Associate that real
      // pointer-up with its recorded block-workspace pointer-down.
      if (trusted && kind === 'pointerUp' && observed.blockPointerActive) {
        targetId = '${ScratchTargetId.BLOCKS}';
        observed.blockPointerActive = false;
      }
      const elapsedMs = Math.max(0, performance.now() - startedAt);
      if (trusted) {
        observed.trustedEvents[kind] = Math.min(10000, observed.trustedEvents[kind] + 1);
        if (['click', 'pointerDown', 'pointerUp', 'input', 'keyDown', 'drag'].includes(kind)) {
          observed.inputRevision = Math.min(1000000, observed.inputRevision + 1);
        }
        if (event instanceof PointerEvent) observed.lastPointer = { x: event.clientX, y: event.clientY };
      }
      // Retain first evidence for each event/control pair so pointer noise cannot
      // evict the actual edit and run inputs. No key values or typed text is read.
      const existingEvent = observed.events.find(item =>
        item.kind === kind && item.targetId === targetId && item.trusted === trusted);
      if (existingEvent) existingEvent.elapsedMs = elapsedMs;
      else if (observed.events.length < 96) {
        observed.events.push({ kind, targetId, trusted, elapsedMs });
      }
    };
    for (const [name, kind] of [
      ['click', 'click'], ['pointerdown', 'pointerDown'], ['pointermove', 'pointerMove'],
      ['pointerup', 'pointerUp'], ['input', 'input'], ['keydown', 'keyDown'],
      ['wheel', 'wheel'], ['dragend', 'drag']
    ]) document.addEventListener(name, event => record(event, kind), true);
    Object.defineProperty(window, '__troScratchObservation', { value: observed, configurable: true });
    return true;
  })()`;
}

const readScratchObservationScript = `(() => {
  ${scratchDomHelpersScript}
  const observed = window.__troScratchObservation;
  if (!observed || typeof observed.trialId !== 'string') return null;
  const score = readScore();
  if (score.value !== observed.lastScore) {
    const elapsedMs = Math.max(0, performance.now() - observed.startedAt);
    if (observed.firstEffectElapsedMs === null) observed.firstEffectElapsedMs = elapsedMs;
    observed.lastEffectElapsedMs = elapsedMs;
    observed.lastScore = score.value;
  }
  const targets = [];
  for (const [id, label, element] of [
    ['${ScratchTargetId.GREEN_FLAG}', 'Start project', readGreenFlag()],
    ['${ScratchTargetId.BLOCKS}', 'Scratch code workspace', readBlocks()],
    ['${ScratchTargetId.FILE}', 'File menu', readFileMenu()],
    ['${ScratchTargetId.SCORE}', 'Observed score monitor', score.element]
  ]) {
    if (!isVisible(element)) continue;
    const bounds = element.getBoundingClientRect();
    targets.push({ id, label, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } });
  }
  return {
    inputRevision: observed.inputRevision,
    state: {
      application: '${EvaluationApplication.SCRATCH}', scratchProject: null, scratchScore: score.value,
      schemaVersion: 1, taskId: '${InteractiveTaskId.DEBUG_SCORE}', trialId: observed.trialId,
      saved: false, dropCompleted: false, projectTitle: document.title.slice(0, 120),
      scrollConfirmed: false, scrollTop: 0, repeatCount: null, validationVisible: false,
      destination: null, trustedEvents: observed.trustedEvents, lastPointer: observed.lastPointer,
      firstEffectElapsedMs: observed.firstEffectElapsedMs, lastEffectElapsedMs: observed.lastEffectElapsedMs,
      events: observed.events, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, targets
    }
  };
})()`;

const startExportScript = `(() => {
  ${scratchDomHelpersScript}
  const item = readMenuItem('Save to your computer');
  if (!(item instanceof HTMLElement)) return false;
  item.click();
  return true;
})()`;

function readLatestTrustedEvent(
  state: WorkspaceState,
  kind: WorkspaceState['events'][number]['kind'],
  targetId: string,
): WorkspaceState['events'][number] | null {
  let latest: WorkspaceState['events'][number] | null = null;
  for (const event of state.events) {
    if (
      event.trusted &&
      event.kind === kind &&
      event.targetId === targetId &&
      (latest === null || event.elapsedMs >= latest.elapsedMs)
    ) {
      latest = event;
    }
  }
  return latest;
}

/** Grades the exported program independently of its labels and the agent's claim.
 * Browser trusted events establish observed input, not a physical student's understanding. */
export function gradeScratchWorkspaceState(
  state: WorkspaceState,
  expectedTrialId: string,
): WorkspaceOutcomeGrade {
  const observed = WorkspaceStateSchema.parse(state);
  const reasons: string[] = [];
  const matchesTrial =
    observed.application === EvaluationApplication.SCRATCH &&
    observed.taskId === InteractiveTaskId.DEBUG_SCORE &&
    observed.trialId === expectedTrialId;
  if (!matchesTrial) {
    reasons.push('scratch_trial_mismatch');
  }
  const program = observed.scratchProject ? gradeScratchProject(observed.scratchProject) : null;
  if (!program) {
    reasons.push('scratch_export_missing_or_stale');
  } else {
    reasons.push(...program.reasons);
  }
  const monitorMatches = observed.scratchScore === 3;
  if (!monitorMatches) {
    reasons.push('scratch_visible_score_not_three');
  }
  const blockDown = readLatestTrustedEvent(
    observed,
    WorkspaceEventKind.POINTER_DOWN,
    ScratchTargetId.BLOCKS,
  );
  const blockUp = readLatestTrustedEvent(
    observed,
    WorkspaceEventKind.POINTER_UP,
    ScratchTargetId.BLOCKS,
  );
  const blockInput =
    blockDown !== null && blockUp !== null && blockUp.elapsedMs > blockDown.elapsedMs;
  const greenFlag = readLatestTrustedEvent(
    observed,
    WorkspaceEventKind.CLICK,
    ScratchTargetId.GREEN_FLAG,
  );
  const greenFlagInput = greenFlag !== null;
  const runAfterEdit = blockInput && greenFlag !== null && greenFlag.elapsedMs > blockUp.elapsedMs;
  // A later workspace selection conservatively requires another green-flag run.
  // Inputs alone cannot establish that a pointer gesture changed a block.
  const trustedInteractionObserved = runAfterEdit;
  if (!blockInput) {
    reasons.push('scratch_block_input_not_observed');
  }
  if (!greenFlagInput) {
    reasons.push('scratch_green_flag_input_not_observed');
  }
  if (!runAfterEdit) {
    reasons.push('scratch_run_after_edit_not_observed');
  }
  const outcomeMatches =
    matchesTrial && program?.supported === true && program.passed && monitorMatches;
  return {
    passed: outcomeMatches && trustedInteractionObserved,
    outcomeMatches,
    trustedInteractionObserved,
    reasons,
  };
}

/** Runs an anonymous real Scratch GUI in the harness's isolated sandboxed window.
 * Fixture import and project export use the website's own File menu. Expensive
 * exports happen only at reset and after the candidate worker has stopped. */
export class ScratchWorkspace {
  private trialId: string | null = null;
  private project: ScratchProject | null = null;
  private exportRevision: number | null = null;
  private exportSequence = 0;
  private outcomeApplicable = false;
  private closed = false;

  constructor(
    private readonly window: ScratchBrowserWindow,
    private readonly root: string,
    private readonly signal?: AbortSignal,
  ) {}

  async reset(
    trialId: string,
    scenarioInput: EvaluationScenario = getDefaultEvaluationScenario(EvaluationApplication.SCRATCH),
  ): Promise<void> {
    this.throwIfCancelled();
    const scenario = EvaluationScenarioSchema.parse(scenarioInput);
    if (scenario.application !== EvaluationApplication.SCRATCH) {
      throw new Error(ScratchWorkspaceFailure.SCENARIO_INVALID);
    }
    const parsed = TrialIdSchema.safeParse(trialId);
    if (!parsed.success) {
      throw new Error(ScratchWorkspaceFailure.TRIAL_INVALID);
    }
    this.trialId = parsed.data;
    this.closed = false;
    this.project = null;
    this.exportRevision = null;
    this.outcomeApplicable = false;
    try {
      await this.awaitOperation(
        () => this.window.loadURL(ScratchEditorUrl),
        () => {
          if (!this.window.isDestroyed()) {
            this.window.webContents.stop();
          }
        },
      );
    } catch {
      this.throwIfCancelled();
      throw new Error(ScratchWorkspaceFailure.PAGE_UNAVAILABLE);
    }
    await this.waitForPage(
      readEditorReadyScript,
      ScratchWorkspaceLimits.EDITOR_TIMEOUT_MS,
      ScratchWorkspaceFailure.EDITOR_UNAVAILABLE,
    );
    await this.openFileMenu(ScratchWorkspaceFailure.IMPORT_FAILED);
    const imported: unknown = await this.executeScript(
      createImportScript(createScratchProjectArchive(scenario.fixture.bug)),
      ScratchWorkspaceFailure.IMPORT_FAILED,
    );
    if (imported !== true) {
      throw new Error(ScratchWorkspaceFailure.IMPORT_FAILED);
    }
    await this.waitForPage(
      readImportReadyScript,
      ScratchWorkspaceLimits.IMPORT_TIMEOUT_MS,
      ScratchWorkspaceFailure.IMPORT_FAILED,
    );
    await this.executeScript(
      createObservationScript(parsed.data),
      ScratchWorkspaceFailure.OBSERVATION_FAILED,
    );
    await this.exportProject();
    const initial = await this.readState();
    if (
      !initial.scratchProject ||
      !gradeScratchProject(initial.scratchProject).supported ||
      gradeScratchProject(initial.scratchProject).passed
    ) {
      throw new Error(ScratchWorkspaceFailure.EXPORT_UNSUPPORTED);
    }
    if (initial.scratchScore !== 0) {
      throw new Error(ScratchWorkspaceFailure.IMPORT_FAILED);
    }
  }

  async readState(): Promise<WorkspaceState> {
    this.throwIfCancelled();
    const observation = await this.readObservation();
    const project = observation.inputRevision === this.exportRevision ? this.project : null;
    this.outcomeApplicable = project !== null && gradeScratchProject(project).supported;
    return WorkspaceStateSchema.parse({ ...observation.state, scratchProject: project });
  }

  async exportProject(): Promise<void> {
    this.throwIfCancelled();
    this.project = null;
    this.exportRevision = null;
    this.outcomeApplicable = false;
    const before = await this.readObservation();
    this.exportSequence += 1;
    const path = join(
      this.root,
      `ScratchProject-${this.trialId ?? 'Unknown'}-${String(this.exportSequence)}.sb3`,
    );
    await this.awaitOperation(() => mkdir(this.root, { recursive: true, mode: 0o700 }));
    await this.downloadProject(path);
    let archive: Uint8Array;
    let archiveSize: number;
    try {
      const metadata = await this.awaitOperation(() => stat(path));
      archiveSize = metadata.size;
    } catch {
      this.throwIfCancelled();
      throw new Error(ScratchWorkspaceFailure.EXPORT_FAILED);
    }
    if (archiveSize > ScratchWorkspaceLimits.MAXIMUM_ARCHIVE_BYTES) {
      throw new Error(ScratchWorkspaceFailure.EXPORT_TOO_LARGE);
    }
    try {
      archive = await this.awaitOperation(() => readFile(path));
    } catch {
      this.throwIfCancelled();
      throw new Error(ScratchWorkspaceFailure.EXPORT_FAILED);
    }
    try {
      const project = parseScratchProjectArchive(archive);
      const after = await this.readObservation();
      if (before.inputRevision !== after.inputRevision) {
        throw new Error(ScratchWorkspaceFailure.EXPORT_FAILED);
      }
      this.project = project;
      this.exportRevision = after.inputRevision;
      this.outcomeApplicable = gradeScratchProject(project).supported;
    } catch {
      this.throwIfCancelled();
      throw new Error(ScratchWorkspaceFailure.EXPORT_FAILED);
    }
  }

  gradeState(state: WorkspaceState, expectedTrialId: string): WorkspaceOutcomeGrade {
    this.throwIfCancelled();
    return gradeScratchWorkspaceState(state, expectedTrialId);
  }

  isOutcomeApplicable(): boolean {
    return !this.signal?.aborted && !this.closed && this.outcomeApplicable;
  }

  /** The composition owns the BrowserWindow. Closing this adapter retires its
   * local observation state and stops navigation without destroying that window. */
  close(): Promise<void> {
    this.closed = true;
    this.project = null;
    this.exportRevision = null;
    this.outcomeApplicable = false;
    if (!this.window.isDestroyed()) {
      this.window.webContents.stop();
    }

    return Promise.resolve();
  }

  private async readObservation(): Promise<z.infer<typeof ObservationSchema>> {
    if (this.closed) {
      throw new Error(ScratchWorkspaceFailure.CLOSED);
    }
    const raw: unknown = await this.executeScript(
      readScratchObservationScript,
      ScratchWorkspaceFailure.OBSERVATION_FAILED,
    );
    const parsed = ObservationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.state.trialId !== this.trialId) {
      throw new Error(ScratchWorkspaceFailure.OBSERVATION_FAILED);
    }
    return parsed.data;
  }

  private async executeScript(script: string, failure: string): Promise<unknown> {
    this.throwIfCancelled();
    try {
      if (this.window.isDestroyed()) {
        throw new Error(failure);
      }
      const url = new URL(this.window.webContents.getURL());
      if (
        url.origin !== 'https://scratch.mit.edu' ||
        url.pathname.replace(/\/$/, '') !== '/projects/editor'
      ) {
        throw new Error(failure);
      }
      const raw: unknown = await this.awaitOperation(() =>
        this.window.webContents.executeJavaScript(script),
      );
      return raw;
    } catch {
      this.throwIfCancelled();
      throw new Error(failure);
    }
  }

  private async waitForPage(script: string, timeoutMs: number, failure: string): Promise<void> {
    this.throwIfCancelled();
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const ready: unknown = await this.executeScript(script, failure);
      if (ready === true) {
        return;
      }
      await this.awaitOperation(() =>
        delay(ScratchWorkspaceLimits.POLL_INTERVAL_MS, undefined, { signal: this.signal }),
      );
    }
    throw new Error(failure);
  }

  private async openFileMenu(failure: string): Promise<void> {
    const opened: unknown = await this.executeScript(openFileMenuScript, failure);
    if (opened !== true) {
      throw new Error(failure);
    }
    // React may commit the menu after the open callback returns. Read it in a
    // separate renderer operation before selecting the upload/download command.
    await this.waitForPage(
      readFileMenuReadyScript,
      ScratchWorkspaceLimits.MENU_TIMEOUT_MS,
      failure,
    );
  }

  private async downloadProject(path: string): Promise<void> {
    this.throwIfCancelled();
    await this.openFileMenu(ScratchWorkspaceFailure.EXPORT_FAILED);
    const session = this.window.webContents.session;
    let download: DownloadItem | null = null;
    const cancelDownload = (): void => {
      download?.cancel();
    };
    let finishDownload: ((reason: string | null) => void) | null = null;
    const completed = new Promise<void>((resolve, reject) => {
      finishDownload = (reason) => {
        if (reason === null) {
          resolve();
        } else {
          reject(new Error(reason));
        }
      };
    });
    // Attach a rejection handler immediately; a download can fail before the
    // asynchronous menu click returns and before the awaiting continuation runs.
    void completed.catch(() => undefined);
    let removeDownloadListeners = (): void => {};
    const listener: DownloadListener = (event, item, contents): void => {
      if (this.signal?.aborted) {
        event.preventDefault();
        finishDownload?.(ScratchWorkspaceFailure.CANCELLED);
        return;
      }
      if (contents !== this.window.webContents) {
        return;
      }
      if (download || !item.getFilename().endsWith('.sb3')) {
        event.preventDefault();
        finishDownload?.(ScratchWorkspaceFailure.EXPORT_FAILED);
        return;
      }
      download = item;
      item.setSavePath(path);
      const checkSize = (): void => {
        if (
          item.getReceivedBytes() > ScratchWorkspaceLimits.MAXIMUM_ARCHIVE_BYTES ||
          item.getTotalBytes() > ScratchWorkspaceLimits.MAXIMUM_ARCHIVE_BYTES
        ) {
          item.cancel();
          finishDownload?.(ScratchWorkspaceFailure.EXPORT_TOO_LARGE);
        }
      };
      item.on('updated', checkSize);
      const completeDownload = (_event: Event, state: string): void => {
        item.removeListener('updated', checkSize);
        finishDownload?.(state === 'completed' ? null : ScratchWorkspaceFailure.EXPORT_FAILED);
      };
      item.once('done', completeDownload);
      removeDownloadListeners = () => {
        item.removeListener('updated', checkSize);
        item.removeListener('done', completeDownload);
      };
      checkSize();
    };
    session.on('will-download', listener);
    const timeout = setTimeout(() => {
      cancelDownload();
      finishDownload?.(ScratchWorkspaceFailure.EXPORT_FAILED);
    }, ScratchWorkspaceLimits.EXPORT_TIMEOUT_MS);
    try {
      const started: unknown = await this.executeScript(
        startExportScript,
        ScratchWorkspaceFailure.EXPORT_FAILED,
      );
      if (started !== true) {
        throw new Error(ScratchWorkspaceFailure.EXPORT_FAILED);
      }
      await this.awaitOperation(() => completed, cancelDownload);
    } catch (error: unknown) {
      cancelDownload();
      throw error;
    } finally {
      clearTimeout(timeout);
      session.removeListener('will-download', listener);
      removeDownloadListeners();
      finishDownload = null;
    }
  }

  private throwIfCancelled(): void {
    if (this.signal?.aborted) {
      this.project = null;
      this.exportRevision = null;
      this.outcomeApplicable = false;
      throw new Error(ScratchWorkspaceFailure.CANCELLED);
    }
  }

  private async awaitOperation<T>(start: () => Promise<T>, cancel?: () => void): Promise<T> {
    this.throwIfCancelled();
    const signal = this.signal;
    if (!signal) {
      return start();
    }
    let removeAbortListener = (): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        try {
          cancel?.();
        } catch {
          // A closed native target can reject stop/cancel; cancellation still wins.
        }
        reject(new Error(ScratchWorkspaceFailure.CANCELLED));
      };
      signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener('abort', abort);
      };
    });
    try {
      this.throwIfCancelled();
      const result = await Promise.race([start(), cancelled]);
      this.throwIfCancelled();
      return result;
    } finally {
      removeAbortListener();
    }
  }
}
