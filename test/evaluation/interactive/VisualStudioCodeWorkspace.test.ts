import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PythonDebugCase } from './PythonDebugCase.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';
import {
  VisualStudioCodeWorkspace,
  VisualStudioCodeWorkspaceFailure,
  VisualStudioCodeLimits,
  gradeVisualStudioCodeState,
  launchVisualStudioCode,
  type VisualStudioCodePorts,
  type VisualStudioCodeProcess,
  type VisualStudioCodeProcessSnapshot,
  type VisualStudioCodeLaunchPorts,
} from './VisualStudioCodeWorkspace.js';

const directories: string[] = [];
const shortProfiles = new Set<string>();

class TestEditorProcess implements VisualStudioCodeProcess {
  started = Promise.resolve();
  private exitedValue = false;
  private completeExit: (() => void) | null = null;
  readonly exited = new Promise<void>((resolve) => {
    this.completeExit = resolve;
  });
  readonly stop = vi.fn<VisualStudioCodeProcess['stop']>(() => {
    this.finish();
  });

  hasExited(): boolean {
    return this.exitedValue;
  }

  hasRunningProcesses(): boolean {
    return !this.exitedValue;
  }

  readLifecycleSnapshot(): VisualStudioCodeProcessSnapshot {
    return {
      processId: 12345,
      leaderExited: this.hasExited(),
      groupRunning: this.hasRunningProcesses(),
      failureCode: null,
      causeCode: null,
    };
  }

  finish(): void {
    this.exitedValue = true;
    this.completeExit?.();
  }
}

async function createFixture(signal?: AbortSignal) {
  const root = await mkdtemp(join(tmpdir(), 'TroVsCodeTest-'));
  directories.push(root);
  const child = new TestEditorProcess();
  const ports = {
    platform: 'darwin',
    now: vi.fn<VisualStudioCodePorts['now']>().mockReturnValue(100),
    checkExecutable: vi.fn<VisualStudioCodePorts['checkExecutable']>().mockResolvedValue(undefined),
    launch: vi
      .fn<VisualStudioCodePorts['launch']>()
      .mockImplementation((_executable, arguments_) => {
        const profile = arguments_[1];
        if (profile?.startsWith('/tmp/TroCode-')) {
          shortProfiles.add(profile);
        }
        return child;
      }),
    environment: { PATH: '/synthetic/bin', HOME: '/synthetic/home' },
  } satisfies VisualStudioCodePorts;
  const workspace = new VisualStudioCodeWorkspace(root, signal, ports);
  return { root, child, ports, workspace, sourcePath: join(root, 'VSCode-PythonOne', 'main.py') };
}

function readLaunchedProfile(ports: Awaited<ReturnType<typeof createFixture>>['ports']): string {
  const profile = ports.launch.mock.calls[0]?.[1][1];
  if (profile === undefined) {
    throw new Error('The synthetic editor profile was not captured.');
  }
  return profile;
}

function createRepairedSource(): string {
  return `${PythonDebugCase.startingSource.trimEnd()}\n    else:\n        print("Số bạn đoán lớn hơn số bí mật")\n`;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const profile of shortProfiles) {
    await rm(profile, { recursive: true, force: true });
  }
  shortProfiles.clear();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('seeds a separate real-editor instance without a normal profile or hidden solution', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  const [executable, args, environment] = fixture.ports.launch.mock.calls[0] ?? [];
  expect(executable).toBe('/Applications/Visual Studio Code.app/Contents/MacOS/Code');
  const profile = readLaunchedProfile(fixture.ports);
  expect(profile).toMatch(/^\/tmp\/TroCode-[A-Za-z0-9]+$/);
  expect(Buffer.byteLength(profile)).toBeLessThan(40);
  expect(args).toEqual([
    '--user-data-dir',
    profile,
    '--extensions-dir',
    join(profile, 'Extensions'),
    '--disable-extensions',
    '--new-window',
    '--skip-welcome',
    '--skip-release-notes',
    '--goto',
    `${fixture.sourcePath}:9:9`,
  ]);
  expect(environment).toEqual(fixture.ports.environment);
  expect(args).not.toContain('--disable-workspace-trust');
  expect(await readFile(fixture.sourcePath, 'utf8')).toBe(PythonDebugCase.startingSource);
  const scenario = await readFile(join(fixture.root, 'VSCode-PythonOne', 'Scenario.json'), 'utf8');
  expect(scenario).not.toContain('observedGuidance');
  expect(scenario).not.toContain('Dedent line 9');
  expect(scenario).toContain('canonical_authored_case');
  expect(scenario).toContain('../Trial-PythonOne/Request.json');
  const state = await fixture.workspace.readState();
  expect(state.pythonSourceChanged).toBe(false);
  expect(fixture.workspace.gradeState(state, 'PythonOne')).toMatchObject({
    passed: false,
    outcomeMatches: false,
    trustedInteractionObserved: false,
  });
  expect(state.events).toEqual([]);
  expect(state.targets).toEqual([]);
  await fixture.workspace.close();
  expect(fixture.child.stop).toHaveBeenCalledWith('SIGTERM');
  await expect(readFile(join(profile, 'User', 'settings.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('grades saved code independently without fabricating native input or Python execution', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  fixture.ports.now.mockReturnValue(450);
  await writeFile(fixture.sourcePath, createRepairedSource());
  const state = await fixture.workspace.readState();
  expect(state.pythonSourceChanged).toBe(true);
  expect(state.firstEffectElapsedMs).toBe(350);
  expect(fixture.workspace.gradeState(state, 'PythonOne')).toEqual({
    passed: true,
    outcomeMatches: true,
    trustedInteractionObserved: false,
    reasons: [],
  });
  expect(Object.values(state.trustedEvents)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  await fixture.workspace.saveOutcome();
  const artifact: unknown = JSON.parse(
    await readFile(join(fixture.root, 'VSCode-PythonOne', 'ProgramOutcome.json'), 'utf8'),
  );
  expect(artifact).toMatchObject({
    trialId: 'PythonOne',
    source: createRepairedSource(),
    pythonExecutionMeasured: false,
    physicalStudentInputMeasured: false,
    studentUnderstandingMeasured: false,
  });
  expect(gradeVisualStudioCodeState(state, 'DifferentTrial').passed).toBe(false);
  await fixture.workspace.close();
});

it('prepares the selected scenario source and cursor and compares later changes with that exact baseline', async () => {
  const fixture = await createFixture();
  const base = getDefaultEvaluationScenario(EvaluationApplication.VSCODE);
  if (base.application !== EvaluationApplication.VSCODE) {
    throw new Error('Expected the registered Python scenario.');
  }
  const source = base.fixture.source.replace('elif doan < so_bi_mat:', 'elif doan > so_bi_mat:');
  const scenario = {
    ...base,
    id: 'DifferentPythonBug',
    fixture: { ...base.fixture, source, cursor: { line: 7, column: 5 } },
  };
  await fixture.workspace.reset('PythonOne', scenario);
  expect(await readFile(fixture.sourcePath, 'utf8')).toBe(source);
  expect(fixture.ports.launch.mock.calls[0]?.[1].at(-1)).toBe(`${fixture.sourcePath}:7:5`);
  expect((await fixture.workspace.readState()).pythonSourceChanged).toBe(false);
  expect(fixture.workspace.getNativeTarget()).toEqual({
    processId: 12345,
    title: 'Tro evaluation - PythonOne - main.py',
    documentName: 'main.py',
  });
  const profile = readLaunchedProfile(fixture.ports);
  const settings = await readFile(join(profile, 'User', 'settings.json'), 'utf8');
  expect(settings).toContain('Tro evaluation - PythonOne - ${activeEditorShort}');
  const recorded = await readFile(join(fixture.root, 'VSCode-PythonOne', 'Scenario.json'), 'utf8');
  expect(recorded).toContain('DifferentPythonBug');
  expect(recorded).not.toContain('observedGuidance');
  await writeFile(fixture.sourcePath, PythonDebugCase.startingSource);
  const changed = await fixture.workspace.readState();
  expect(changed.pythonSourceChanged).toBe(true);
  expect(fixture.workspace.gradeState(changed, 'PythonOne').outcomeMatches).toBe(false);
  await fixture.workspace.close();
  expect(fixture.workspace.getNativeTarget()).toBeNull();
});

it('rejects a Scratch scenario before launching or writing an editor fixture', async () => {
  const fixture = await createFixture();
  await expect(
    fixture.workspace.reset(
      'PythonOne',
      getDefaultEvaluationScenario(EvaluationApplication.SCRATCH),
    ),
  ).rejects.toThrow(VisualStudioCodeWorkspaceFailure.SCENARIO_INVALID);
  expect(fixture.ports.launch).not.toHaveBeenCalled();
  await expect(readFile(fixture.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps unsupported or oversized saved code unassessed rather than claiming a correct program', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  await writeFile(fixture.sourcePath, 'import os\n');
  expect(
    fixture.workspace.gradeState(await fixture.workspace.readState(), 'PythonOne').passed,
  ).toBe(false);
  expect(fixture.workspace.isOutcomeApplicable()).toBe(false);
  await writeFile(fixture.sourcePath, 'x'.repeat(VisualStudioCodeLimits.SOURCE_BYTES + 1));
  const oversized = await fixture.workspace.readState();
  expect(oversized.pythonSource).toBeNull();
  expect(fixture.workspace.isOutcomeApplicable()).toBe(false);
  await fixture.workspace.close();
});

it('rejects a source symlink instead of reading another local file', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  const outside = join(fixture.root, 'Private.txt');
  await writeFile(outside, 'synthetic private content');
  await rm(fixture.sourcePath);
  await symlink(outside, fixture.sourcePath);
  const state = await fixture.workspace.readState();
  expect(state.pythonSource).toBeNull();
  expect(fixture.workspace.gradeState(state, 'PythonOne').passed).toBe(false);
  await fixture.workspace.close();
});

it('closes the previous owned instance before resetting for a fresh trial', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  const second = new TestEditorProcess();
  fixture.ports.launch.mockReturnValue(second);
  await fixture.workspace.reset('PythonTwo');
  expect(fixture.child.hasExited()).toBe(true);
  expect((await fixture.workspace.readState()).trialId).toBe('PythonTwo');
  await fixture.workspace.close();
  expect(second.hasExited()).toBe(true);
});

it('does not write files or launch when cancellation predates reset', async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = await createFixture(controller.signal);
  await expect(fixture.workspace.reset('PythonOne')).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.CANCELLED,
  );
  expect(fixture.ports.checkExecutable).not.toHaveBeenCalled();
  expect(fixture.ports.launch).not.toHaveBeenCalled();
});

it('stops only the owned editor on cancellation and refuses later observation or export', async () => {
  const controller = new AbortController();
  const fixture = await createFixture(controller.signal);
  await fixture.workspace.reset('PythonOne');
  controller.abort();
  await fixture.workspace.close();
  expect(fixture.child.stop).toHaveBeenCalledOnce();
  await expect(fixture.workspace.readState()).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.CANCELLED,
  );
  await expect(fixture.workspace.saveOutcome()).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.CANCELLED,
  );
});

it('cancels a pending process startup without waiting for its ready acknowledgment', async () => {
  const controller = new AbortController();
  const fixture = await createFixture(controller.signal);
  fixture.child.started = new Promise<void>(() => {});
  const resetting = fixture.workspace.reset('PythonOne');
  const rejected = expect(resetting).rejects.toThrow(VisualStudioCodeWorkspaceFailure.CANCELLED);
  await vi.waitFor(() => {
    expect(fixture.ports.launch).toHaveBeenCalledOnce();
  });
  controller.abort();
  await rejected;
  expect(fixture.child.stop).toHaveBeenCalledWith('SIGTERM');
});

it('rejects path traversal and unsupported platforms before launching an editor', async () => {
  const fixture = await createFixture();
  await expect(fixture.workspace.reset('../Other')).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.TRIAL_INVALID,
  );
  const windows = new VisualStudioCodeWorkspace(fixture.root, undefined, {
    ...fixture.ports,
    platform: 'win32',
  });
  await expect(windows.reset('PythonOne')).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.PLATFORM_UNSUPPORTED,
  );
  expect(fixture.ports.launch).not.toHaveBeenCalled();
});

it('reports a missing editor or exited process without exposing raw process errors', async () => {
  const fixture = await createFixture();
  fixture.ports.checkExecutable.mockRejectedValue(new Error('synthetic private path'));
  await expect(fixture.workspace.reset('PythonOne')).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.EDITOR_UNAVAILABLE,
  );
  fixture.ports.checkExecutable.mockResolvedValue(undefined);
  await fixture.workspace.reset('PythonOne');
  fixture.child.finish();
  await expect(fixture.workspace.readState()).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.EDITOR_CLOSED,
  );
  await fixture.workspace.close();
});

it('force-stops a stuck owned editor with bounded retirement and reports an unconfirmed stop', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  fixture.child.stop.mockImplementation(() => undefined);
  vi.useFakeTimers();
  const stopping = fixture.workspace.close();
  const rejected = expect(stopping).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
  );
  await vi.advanceTimersByTimeAsync(
    VisualStudioCodeLimits.GRACEFUL_STOP_MS + VisualStudioCodeLimits.FORCE_STOP_MS,
  );
  await rejected;
  expect(fixture.child.stop.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
});

it('does not declare retirement when helpers remain after the original leader exits', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  fixture.child.hasRunningProcesses = () => true;
  fixture.child.finish();
  vi.useFakeTimers();
  const stopping = fixture.workspace.close();
  const rejected = expect(stopping).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
  );
  await vi.advanceTimersByTimeAsync(VisualStudioCodeLimits.GRACEFUL_STOP_MS);
  await rejected;
  expect(fixture.child.stop).not.toHaveBeenCalled();
});

it('persists bounded launch and retirement diagnostics without arguments, paths or source', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  fixture.ports.now.mockReturnValue(250);
  await fixture.workspace.close();
  const raw = await readFile(
    join(fixture.root, 'VSCode-PythonOne', 'VSCodeLifecycle.json'),
    'utf8',
  );
  const artifact: unknown = JSON.parse(raw);
  expect(artifact).toMatchObject({
    schemaVersion: 1,
    trialId: 'PythonOne',
    eventsDropped: 0,
    events: [
      {
        stage: 'launched',
        processId: 12345,
        leaderExited: false,
        groupRunning: true,
        attemptedSignals: [],
      },
      { stage: 'started', processId: 12345 },
      { stage: 'stop_requested', processId: 12345, elapsedMs: 150 },
      { stage: 'term_attempted', attemptedSignals: ['SIGTERM'] },
      { stage: 'term_returned', attemptedSignals: ['SIGTERM'] },
      { stage: 'stopped', leaderExited: true, groupRunning: false },
    ],
  });
  expect(raw).not.toContain(fixture.root);
  expect(raw).not.toContain('/Applications');
  expect(raw).not.toContain('PATH');
  expect(raw).not.toContain('so_bi_mat');
  expect(raw).not.toContain('/tmp/TroCode-');
});

it('records the leader-exited and live-group evidence behind an unconfirmed cleanup', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  fixture.child.hasRunningProcesses = () => true;
  fixture.child.finish();
  vi.useFakeTimers();
  const stopping = fixture.workspace.close();
  const rejected = expect(stopping).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
  );
  await vi.advanceTimersByTimeAsync(VisualStudioCodeLimits.GRACEFUL_STOP_MS);
  await rejected;
  const artifact: unknown = JSON.parse(
    await readFile(join(fixture.root, 'VSCode-PythonOne', 'VSCodeLifecycle.json'), 'utf8'),
  );
  const expectedEvents: unknown = expect.arrayContaining([
    {
      processId: 12345,
      leaderExited: true,
      groupRunning: true,
      failureCode: 'vscode_stop_unconfirmed',
      causeCode: null,
      stage: 'failed',
      elapsedMs: 0,
      attemptedSignals: [],
    },
  ]);
  expect(artifact).toMatchObject({ events: expectedEvents });
  expect(fixture.child.stop).not.toHaveBeenCalled();
});

it('allowlists lifecycle failure codes without retaining raw process errors', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  fixture.child.stop.mockImplementation(() => {
    throw new Error(VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED, {
      cause: Object.assign(new Error('private path and configuration'), { code: 'EPERM' }),
    });
  });
  await expect(fixture.workspace.close()).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
  );
  const raw = await readFile(
    join(fixture.root, 'VSCode-PythonOne', 'VSCodeLifecycle.json'),
    'utf8',
  );
  const artifact: unknown = JSON.parse(raw);
  const expectedEvents: unknown = expect.arrayContaining([
    expect.objectContaining({
      stage: 'failed',
      failureCode: 'vscode_stop_unconfirmed',
      causeCode: 'EPERM',
      attemptedSignals: ['SIGTERM'],
    }),
  ]);
  expect(artifact).toMatchObject({ events: expectedEvents });
  expect(raw).not.toContain('private path');
  expect(raw).not.toContain('configuration');
});

it('preserves only its owned short profile when process retirement is unconfirmed', async () => {
  const fixture = await createFixture();
  await fixture.workspace.reset('PythonOne');
  const profile = readLaunchedProfile(fixture.ports);
  fixture.child.hasRunningProcesses = () => true;
  fixture.child.finish();
  vi.useFakeTimers();
  const stopping = fixture.workspace.close();
  const rejected = expect(stopping).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
  );
  await vi.advanceTimersByTimeAsync(VisualStudioCodeLimits.GRACEFUL_STOP_MS);
  await rejected;
  expect(await readFile(join(profile, 'User', 'settings.json'), 'utf8')).toContain(
    'files.autoSave',
  );
  await expect(fixture.workspace.reset('PythonTwo')).rejects.toThrow(
    VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
  );
  expect(fixture.ports.launch).toHaveBeenCalledOnce();
});

it('cleans its short profile when the editor cannot be launched', async () => {
  const fixture = await createFixture();
  fixture.ports.launch.mockImplementation(() => {
    throw new Error('Synthetic launch failure.');
  });
  await expect(fixture.workspace.reset('PythonOne')).rejects.toThrow('Synthetic launch failure.');
  const profile = readLaunchedProfile(fixture.ports);
  await expect(readFile(join(profile, 'User', 'settings.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(fixture.sourcePath, 'utf8')).toBe(PythonDebugCase.startingSource);
});

function createNativeProcessFixture() {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 777001 });
  const signalProcess = vi.fn<VisualStudioCodeLaunchPorts['signalProcess']>();
  const spawnProcess = vi.fn<VisualStudioCodeLaunchPorts['spawn']>().mockReturnValue(child);
  const editor = launchVisualStudioCode(
    '/synthetic/Code',
    [],
    { PATH: '/synthetic/bin' },
    {
      spawn: spawnProcess,
      signalProcess,
    },
  );
  child.emit('spawn');
  return { child, signalProcess, editor };
}

it('treats EPERM as uncertain until an ESRCH observation confirms group retirement', async () => {
  const fixture = createNativeProcessFixture();
  await fixture.editor.started;
  fixture.signalProcess.mockImplementation(() => {
    throw Object.assign(new Error('synthetic permission response'), { code: 'EPERM' });
  });
  expect(fixture.editor.hasRunningProcesses()).toBe(true);
  expect(() => {
    fixture.editor.stop('SIGTERM');
  }).not.toThrow();
  expect(fixture.editor.readLifecycleSnapshot()).toMatchObject({
    processId: 777001,
    leaderExited: false,
    groupRunning: null,
    causeCode: 'EPERM',
  });
  fixture.child.emit('exit', 0, null);
  expect(fixture.editor.hasExited()).toBe(true);
  expect(fixture.editor.hasRunningProcesses()).toBe(true);
  fixture.signalProcess.mockImplementation(() => {
    throw Object.assign(new Error('synthetic absent group'), { code: 'ESRCH' });
  });
  expect(fixture.editor.hasRunningProcesses()).toBe(false);
  expect(fixture.editor.readLifecycleSnapshot()).toMatchObject({
    groupRunning: false,
    failureCode: null,
  });
});

it('does not suppress other process-group failures or treat persistent EPERM as absence', async () => {
  const fixture = createNativeProcessFixture();
  await fixture.editor.started;
  fixture.signalProcess.mockImplementation(() => {
    throw Object.assign(new Error('synthetic access response'), { code: 'EACCES' });
  });
  expect(() => fixture.editor.hasRunningProcesses()).toThrow(
    VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED,
  );
  expect(() => {
    fixture.editor.stop('SIGTERM');
  }).toThrow(VisualStudioCodeWorkspaceFailure.STOP_UNCONFIRMED);
  fixture.signalProcess.mockImplementation(() => {
    throw Object.assign(new Error('synthetic permission response'), { code: 'EPERM' });
  });
  fixture.editor.stop('SIGTERM');
  fixture.editor.stop('SIGKILL');
  expect(fixture.editor.hasRunningProcesses()).toBe(true);
  expect(fixture.editor.readLifecycleSnapshot().groupRunning).toBeNull();
  fixture.child.emit('exit', 0, null);
});
