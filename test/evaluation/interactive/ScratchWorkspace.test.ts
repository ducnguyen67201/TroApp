import { expect, it, vi } from 'vitest';
import { EvaluationApplication } from './EvaluationApplication.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';
import {
  InteractiveTaskId,
  WorkspaceEventKind,
  WorkspaceStateSchema,
  type WorkspaceState,
} from './InteractiveStudyWorkspace.js';
import {
  createScratchProjectArchive,
  parseScratchProjectArchive,
  type ScratchProject,
} from './ScratchProject.js';
import {
  gradeScratchWorkspaceState,
  ScratchWorkspace,
  ScratchWorkspaceFailure,
  type ScratchBrowserWindow,
} from './ScratchWorkspace.js';

function createRepairedProject(): ScratchProject {
  const project = parseScratchProjectArchive(createScratchProjectArchive());
  const sprite = project.targets.find((target) => !target.isStage);
  const stage = project.targets.find((target) => target.isStage);
  if (!sprite || !stage) {
    throw new Error('Fixture targets missing.');
  }
  const flag = sprite.blocks['WhenFlag'];
  const repeat = sprite.blocks['RepeatTurns'];
  const reset = sprite.blocks['ResetScore'];
  const increment = sprite.blocks['IncreaseScore'];
  const score = stage.variables['TroScoreVariable'];
  if (
    !flag ||
    Array.isArray(flag) ||
    !repeat ||
    Array.isArray(repeat) ||
    !reset ||
    Array.isArray(reset) ||
    !increment ||
    Array.isArray(increment) ||
    !score
  ) {
    throw new Error('Fixture program missing.');
  }
  flag.next = 'ResetScore';
  reset.parent = 'WhenFlag';
  reset.next = 'RepeatTurns';
  repeat.parent = 'ResetScore';
  repeat.inputs['SUBSTACK'] = [2, 'IncreaseScore'];
  increment.parent = 'RepeatTurns';
  score[1] = 3;
  return project;
}

function createObservedState(
  project: ScratchProject | null = createRepairedProject(),
): WorkspaceState {
  return WorkspaceStateSchema.parse({
    application: EvaluationApplication.SCRATCH,
    scratchProject: project,
    scratchScore: 3,
    schemaVersion: 1,
    taskId: InteractiveTaskId.DEBUG_SCORE,
    trialId: 'ScratchOne',
    saved: false,
    dropCompleted: false,
    projectTitle: 'Scratch',
    scrollConfirmed: false,
    scrollTop: 0,
    repeatCount: null,
    validationVisible: false,
    destination: null,
    trustedEvents: {
      click: 1,
      pointerDown: 1,
      pointerMove: 1,
      pointerUp: 1,
      input: 0,
      keyDown: 0,
      wheel: 0,
      drag: 0,
    },
    lastPointer: { x: 100, y: 100 },
    firstEffectElapsedMs: 300,
    lastEffectElapsedMs: 300,
    events: [
      {
        kind: WorkspaceEventKind.POINTER_DOWN,
        targetId: 'scratch-blocks',
        trusted: true,
        elapsedMs: 100,
      },
      {
        kind: WorkspaceEventKind.POINTER_UP,
        targetId: 'scratch-blocks',
        trusted: true,
        elapsedMs: 200,
      },
      {
        kind: WorkspaceEventKind.CLICK,
        targetId: 'scratch-green-flag',
        trusted: true,
        elapsedMs: 300,
      },
    ],
    viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
    targets: [],
  });
}

it('requires independent exported program, visible score and real Scratch input evidence', () => {
  expect(gradeScratchWorkspaceState(createObservedState(), 'ScratchOne')).toEqual({
    passed: true,
    outcomeMatches: true,
    trustedInteractionObserved: true,
    reasons: [],
  });
});

it('does not accept a displayed three when the exported program still resets each turn', () => {
  const state = createObservedState(parseScratchProjectArchive(createScratchProjectArchive()));
  expect(gradeScratchWorkspaceState(state, 'ScratchOne').outcomeMatches).toBe(false);
});

it('does not accept missing or stale project data or a different trial', () => {
  expect(gradeScratchWorkspaceState(createObservedState(null), 'ScratchOne').reasons).toContain(
    'scratch_export_missing_or_stale',
  );
  expect(gradeScratchWorkspaceState(createObservedState(), 'ScratchOther').reasons).toContain(
    'scratch_trial_mismatch',
  );
});

it('requires the score read from the live monitor independently of the exported variable', () => {
  const state = createObservedState();
  state.scratchScore = null;
  expect(gradeScratchWorkspaceState(state, 'ScratchOne').outcomeMatches).toBe(false);
});

it('does not turn synthetic clicks or the old controlled fixture buttons into native Scratch evidence', () => {
  const state = createObservedState();
  state.events = [
    {
      kind: WorkspaceEventKind.CLICK,
      targetId: 'scratch-green-flag',
      trusted: false,
      elapsedMs: 100,
    },
    {
      kind: WorkspaceEventKind.CLICK,
      targetId: 'move-reset-before-loop',
      trusted: true,
      elapsedMs: 200,
    },
    { kind: WorkspaceEventKind.CLICK, targetId: 'run-three-turns', trusted: true, elapsedMs: 300 },
  ];
  const grade = gradeScratchWorkspaceState(state, 'ScratchOne');
  expect(grade.outcomeMatches).toBe(true);
  expect(grade.passed).toBe(false);
  expect(grade.trustedInteractionObserved).toBe(false);
});

it('requires the latest green-flag run to follow the latest completed block gesture', () => {
  const state = createObservedState();
  state.events = [
    {
      kind: WorkspaceEventKind.CLICK,
      targetId: 'scratch-green-flag',
      trusted: true,
      elapsedMs: 100,
    },
    {
      kind: WorkspaceEventKind.POINTER_DOWN,
      targetId: 'scratch-blocks',
      trusted: true,
      elapsedMs: 200,
    },
    {
      kind: WorkspaceEventKind.POINTER_UP,
      targetId: 'scratch-blocks',
      trusted: true,
      elapsedMs: 300,
    },
  ];
  const grade = gradeScratchWorkspaceState(state, 'ScratchOne');
  expect(grade.passed).toBe(false);
  expect(grade.reasons).toContain('scratch_run_after_edit_not_observed');
});

it('does not accept an unfinished pointer gesture after the last run', () => {
  const state = createObservedState();
  state.events.push({
    kind: WorkspaceEventKind.POINTER_DOWN,
    targetId: 'scratch-blocks',
    trusted: true,
    elapsedMs: 400,
  });
  expect(gradeScratchWorkspaceState(state, 'ScratchOne').passed).toBe(false);
});

function createTestWindow(load: () => Promise<void>) {
  return {
    isDestroyed: () => false,
    loadURL: vi.fn(load),
    webContents: {
      getURL: () => 'https://scratch.mit.edu/projects/editor/',
      executeJavaScript: vi.fn<(script: string) => Promise<unknown>>().mockResolvedValue(false),
      stop: vi.fn<() => void>(),
      session: {
        on: vi.fn<ScratchBrowserWindow['webContents']['session']['on']>(),
        removeListener: vi.fn<ScratchBrowserWindow['webContents']['session']['removeListener']>(),
      },
    },
  } satisfies ScratchBrowserWindow;
}

it('does not navigate or touch the page when reset starts after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const window = createTestWindow(() => Promise.resolve());
  const workspace = new ScratchWorkspace(window, '/unused-scratch-test', controller.signal);
  await expect(workspace.reset('ScratchCancelled')).rejects.toThrow(
    ScratchWorkspaceFailure.CANCELLED,
  );
  expect(window.loadURL).not.toHaveBeenCalled();
  expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
});

it('rejects another application scenario before opening Scratch', async () => {
  const window = createTestWindow(() => Promise.resolve());
  const workspace = new ScratchWorkspace(window, '/unused-scratch-test');
  await expect(
    workspace.reset('ScratchOne', getDefaultEvaluationScenario(EvaluationApplication.VSCODE)),
  ).rejects.toThrow(ScratchWorkspaceFailure.SCENARIO_INVALID);
  expect(window.loadURL).not.toHaveBeenCalled();
});

it('retires its observation state without destroying the composition-owned window', async () => {
  const window = createTestWindow(() => Promise.resolve());
  const workspace = new ScratchWorkspace(window, '/unused-scratch-test');
  await workspace.close();
  expect(window.webContents.stop).toHaveBeenCalledOnce();
  expect(workspace.isOutcomeApplicable()).toBe(false);
  await expect(workspace.readState()).rejects.toThrow(ScratchWorkspaceFailure.CLOSED);
  expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
});

it('stops an outstanding navigation promptly on cancellation and never imports the fixture', async () => {
  let finishLoad = (): void => {};
  const window = createTestWindow(
    () =>
      new Promise<void>((resolve) => {
        finishLoad = resolve;
      }),
  );
  const controller = new AbortController();
  const workspace = new ScratchWorkspace(window, '/unused-scratch-test', controller.signal);
  const pending = workspace.reset('ScratchCancelled');
  controller.abort();
  await expect(pending).rejects.toThrow(ScratchWorkspaceFailure.CANCELLED);
  expect(window.webContents.stop).toHaveBeenCalledOnce();
  expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
  expect(workspace.isOutcomeApplicable()).toBe(false);
  finishLoad();
});
