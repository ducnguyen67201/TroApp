import { expect, it, vi } from 'vitest';
import {
  ApplicationAdapterFailure,
  createApplicationAdapter,
  type ApplicationAdapterFactories,
} from './ApplicationAdapter.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import { WorkspaceStateSchema } from './InteractiveStudyWorkspace.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';
import type { ScratchBrowserWindow } from './ScratchWorkspace.js';

function createState() {
  return WorkspaceStateSchema.parse({
    schemaVersion: 1,
    taskId: 'DebugPython',
    trialId: 'TrialOne',
    application: EvaluationApplication.VSCODE,
    saved: true,
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
    firstEffectElapsedMs: null,
    lastEffectElapsedMs: null,
    events: [],
    viewport: { width: 1, height: 1, devicePixelRatio: 1 },
    targets: [],
  });
}

function createFactories() {
  const state = createState();
  const grade = {
    passed: false,
    outcomeMatches: false,
    trustedInteractionObserved: false,
    reasons: ['authored_bug_present'],
  };
  const workspace = {
    reset: vi
      .fn<ReturnType<ApplicationAdapterFactories['createPythonWorkspace']>['reset']>()
      .mockResolvedValue(undefined),
    readState: vi
      .fn<ReturnType<ApplicationAdapterFactories['createPythonWorkspace']>['readState']>()
      .mockResolvedValue(state),
    gradeState: vi
      .fn<ReturnType<ApplicationAdapterFactories['createPythonWorkspace']>['gradeState']>()
      .mockReturnValue(grade),
    isOutcomeApplicable: vi.fn<() => boolean>().mockReturnValue(true),
    saveOutcome: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    exportProject: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getNativeTarget: vi
      .fn<ReturnType<ApplicationAdapterFactories['createPythonWorkspace']>['getNativeTarget']>()
      .mockReturnValue({
        processId: 77,
        title: 'Tro evaluation - TrialOne - main.py',
        documentName: 'main.py',
      }),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const factories = {
    createPythonWorkspace: vi
      .fn<ApplicationAdapterFactories['createPythonWorkspace']>()
      .mockReturnValue(workspace),
    createScratchWorkspace: vi
      .fn<ApplicationAdapterFactories['createScratchWorkspace']>()
      .mockReturnValue(workspace),
  } satisfies ApplicationAdapterFactories;
  return { state, grade, workspace, factories };
}

function createWindow(): ScratchBrowserWindow {
  return {
    isDestroyed: () => false,
    loadURL: vi.fn<ScratchBrowserWindow['loadURL']>().mockResolvedValue(undefined),
    webContents: {
      getURL: () => 'https://scratch.mit.edu/projects/editor/',
      executeJavaScript: vi
        .fn<ScratchBrowserWindow['webContents']['executeJavaScript']>()
        .mockResolvedValue(null),
      stop: vi.fn<() => void>(),
      session: {
        on: vi.fn<ScratchBrowserWindow['webContents']['session']['on']>(),
        removeListener: vi.fn<ScratchBrowserWindow['webContents']['session']['removeListener']>(),
      },
    },
  };
}

it('runs Python preparation, observation, finalization and cleanup through the shared boundary', async () => {
  const fixture = createFactories();
  const adapter = createApplicationAdapter(
    { application: EvaluationApplication.VSCODE, root: '/synthetic' },
    fixture.factories,
  );
  const scenario = getDefaultEvaluationScenario(EvaluationApplication.VSCODE);
  await adapter.prepare(scenario, 'TrialOne');
  expect(fixture.workspace.reset).toHaveBeenCalledWith('TrialOne', scenario);
  const state = await adapter.observe();
  expect(state).toBe(fixture.state);
  expect(adapter.grade(state, 'TrialOne')).toBe(fixture.grade);
  expect(fixture.workspace.gradeState).toHaveBeenCalledWith(state, 'TrialOne');
  expect(adapter.supportsOutcome()).toBe(true);
  expect(adapter.getNativeTarget()).toEqual({
    processId: 77,
    title: 'Tro evaluation - TrialOne - main.py',
    documentName: 'main.py',
  });
  await adapter.finalize();
  expect(fixture.workspace.saveOutcome).toHaveBeenCalledOnce();
  expect(fixture.workspace.exportProject).not.toHaveBeenCalled();
  await adapter.close();
  expect(fixture.workspace.close).toHaveBeenCalledOnce();
  expect(fixture.factories.createScratchWorkspace).not.toHaveBeenCalled();
});

it('uses the same lifecycle for Scratch while keeping its export and DOM observation semantics', async () => {
  const fixture = createFactories();
  const window = createWindow();
  const adapter = createApplicationAdapter(
    { application: EvaluationApplication.SCRATCH, root: '/synthetic', window },
    fixture.factories,
  );
  const scenario = getDefaultEvaluationScenario(EvaluationApplication.SCRATCH);
  await adapter.prepare(scenario, 'TrialOne');
  expect(fixture.workspace.reset).toHaveBeenCalledWith('TrialOne', scenario);
  expect(await adapter.observe()).toBe(fixture.state);
  expect(adapter.getNativeTarget()).toBeNull();
  await adapter.finalize();
  expect(fixture.workspace.exportProject).toHaveBeenCalledOnce();
  expect(fixture.workspace.saveOutcome).not.toHaveBeenCalled();
  await adapter.close();
  expect(fixture.workspace.close).toHaveBeenCalledOnce();
  expect(fixture.factories.createScratchWorkspace).toHaveBeenCalledWith(
    window,
    '/synthetic',
    undefined,
  );
});

it('rejects a scenario for another application before its workspace is reset', async () => {
  const fixture = createFactories();
  const adapter = createApplicationAdapter(
    { application: EvaluationApplication.VSCODE, root: '/synthetic' },
    fixture.factories,
  );
  await expect(
    adapter.prepare(getDefaultEvaluationScenario(EvaluationApplication.SCRATCH), 'TrialOne'),
  ).rejects.toThrow(ApplicationAdapterFailure.SCENARIO_MISMATCH);
  expect(fixture.workspace.reset).not.toHaveBeenCalled();
});
