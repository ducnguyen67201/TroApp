import { Window } from 'happy-dom';
import { expect, it } from 'vitest';
import {
  DebugScoreBlockKind,
  InteractiveTaskId,
  WorkspaceDestination,
  WorkspaceEventKind,
  WorkspaceObservationLimits,
  WorkspaceStateSchema,
  createInteractiveCases,
  createWorkspaceHtml,
  gradeWorkspaceOutcome,
  readWorkspaceStateScript,
  type InteractiveCase,
  type WorkspaceState,
} from './InteractiveStudyWorkspace.js';

function readCase(id: InteractiveCase['id'], repetition = 1): InteractiveCase {
  const scenario = createInteractiveCases(repetition).find((item) => item.id === id);
  if (!scenario) {
    throw new Error('Missing interactive scenario.');
  }
  return scenario;
}

function createState(taskId: InteractiveCase['id']): WorkspaceState {
  return {
    schemaVersion: 1,
    taskId,
    trialId: 'TrialOne',
    saved: false,
    dropCompleted: false,
    projectTitle: '',
    scrollConfirmed: false,
    scrollTop: 0,
    repeatCount: null,
    validationVisible: taskId === InteractiveTaskId.RECOVERY,
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
    viewport: { width: 1024, height: 768, devicePixelRatio: 1 },
    targets: [],
  };
}

function recordClick(state: WorkspaceState, targetId: string): void {
  state.trustedEvents.click += 1;
  state.events.push({ kind: WorkspaceEventKind.CLICK, targetId, trusted: true, elapsedMs: 100 });
}

function createScoreState(resetBeforeLoop: boolean): WorkspaceState {
  const reset = { kind: DebugScoreBlockKind.RESET_SCORE };
  const increment = { kind: DebugScoreBlockKind.INCREMENT_SCORE };
  const repeat = {
    kind: DebugScoreBlockKind.REPEAT,
    turns: 3,
    body: resetBeforeLoop ? [increment] : [reset, increment],
  };
  const score = resetBeforeLoop ? 3 : 1;
  return {
    ...createState(InteractiveTaskId.DEBUG_SCORE),
    debugScore: {
      blocks: resetBeforeLoop ? [reset, repeat] : [repeat],
      programRevision: 1,
      lastRun: { turns: 3, score, programRevision: 1 },
    },
    scoreAfterThreeTurns: score,
  };
}

it('defines eight cases and varies only the earlier history assignment', () => {
  const first = createInteractiveCases(1);
  expect(first.map((scenario) => scenario.id)).toEqual(Object.values(InteractiveTaskId));
  const before = readCase(InteractiveTaskId.HISTORY, 1);
  const after = readCase(InteractiveTaskId.HISTORY, 2);
  expect(before.request).toBe(after.request);
  expect(before.expectedState.destination).toBe(WorkspaceDestination.BLUE);
  expect(after.expectedState.destination).toBe(WorkspaceDestination.GREEN);
  expect(before.historyText).not.toBe(after.historyText);
  expect(() => createInteractiveCases(0)).toThrow();
});

it('requires the actual VS Code adapter for the customer Python scenario', () => {
  expect(readCase(InteractiveTaskId.DEBUG_PYTHON).request).toBeTruthy();
  expect(() =>
    createWorkspaceHtml({ taskId: InteractiveTaskId.DEBUG_PYTHON, trialId: 'PythonOne' }),
  ).toThrow('actual VS Code');
  expect(
    gradeWorkspaceOutcome(
      readCase(InteractiveTaskId.DEBUG_PYTHON),
      createState(InteractiveTaskId.DEBUG_PYTHON),
    ).reasons,
  ).toContain('python_case_requires_vscode_adapter');
});

it('asks for score debugging without supplying the repair or earlier guidance', () => {
  const scenario = readCase(InteractiveTaskId.DEBUG_SCORE);
  expect(scenario.request).toBe(
    'My score should go up by one each turn. After three turns it should be 3, but it shows 1. Help me debug this.',
  );
  expect(scenario.historyText).toBe('');
  expect(scenario.expectedState).toEqual({ scoreAfterThreeTurns: 3 });
  const html = createWorkspaceHtml({ taskId: InteractiveTaskId.DEBUG_SCORE, trialId: 'DebugOne' });
  expect(html).not.toContain('debug_score_behavior_mismatch');
  expect(html).not.toContain('scoreAfterThreeTurns: 3');
});

it('checks general score behavior and a current observed run with native target evidence', () => {
  const scenario = readCase(InteractiveTaskId.DEBUG_SCORE);
  const state = createScoreState(true);
  expect(gradeWorkspaceOutcome(scenario, state)).toMatchObject({
    passed: false,
    outcomeMatches: true,
    trustedInteractionObserved: false,
  });
  recordClick(state, 'move-reset-before-loop');
  expect(gradeWorkspaceOutcome(scenario, state).reasons).toContain(
    'missing_trusted_click_evidence',
  );
  recordClick(state, 'run-score');
  expect(gradeWorkspaceOutcome(scenario, state, 'TrialOne')).toEqual({
    passed: true,
    outcomeMatches: true,
    trustedInteractionObserved: true,
    reasons: [],
  });
  state.events = state.events.map((event) => ({ ...event, trusted: false }));
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(false);
});

it('rejects a displayed three when the AST still resets inside the repeat', () => {
  const state = createScoreState(false);
  state.scoreAfterThreeTurns = 3;
  if (!state.debugScore?.lastRun) {
    throw new Error('Missing score fixture state.');
  }
  state.debugScore.lastRun.score = 3;
  recordClick(state, 'move-reset-before-loop');
  recordClick(state, 'run-score');
  const grade = gradeWorkspaceOutcome(readCase(InteractiveTaskId.DEBUG_SCORE), state);
  expect(grade.outcomeMatches).toBe(false);
  expect(grade.reasons).toEqual(
    expect.arrayContaining([
      'debug_score_behavior_mismatch:3',
      'debug_score_behavior_mismatch:5',
      'debug_score_observed_run_mismatch',
    ]),
  );
});

it('rejects a hard-coded three on the zero-, one- and five-turn counterfactuals', () => {
  const state = createScoreState(true);
  if (!state.debugScore) {
    throw new Error('Missing score fixture state.');
  }
  state.debugScore.blocks = [
    { kind: DebugScoreBlockKind.INCREMENT_SCORE },
    { kind: DebugScoreBlockKind.INCREMENT_SCORE },
    { kind: DebugScoreBlockKind.INCREMENT_SCORE },
  ];
  recordClick(state, 'move-reset-before-loop');
  recordClick(state, 'run-score');
  const grade = gradeWorkspaceOutcome(readCase(InteractiveTaskId.DEBUG_SCORE), state);
  expect(grade.passed).toBe(false);
  expect(grade.reasons).toEqual(
    expect.arrayContaining([
      'debug_score_repeat_count_mismatch',
      'debug_score_behavior_mismatch:0',
      'debug_score_behavior_mismatch:1',
      'debug_score_behavior_mismatch:5',
    ]),
  );
});

it('requires the repaired program to be rerun for three turns after its last edit', () => {
  const scenario = readCase(InteractiveTaskId.DEBUG_SCORE);
  const state = createScoreState(true);
  recordClick(state, 'move-reset-before-loop');
  recordClick(state, 'run-score');
  if (!state.debugScore?.lastRun) {
    throw new Error('Missing score fixture state.');
  }
  state.debugScore.programRevision = 2;
  expect(gradeWorkspaceOutcome(scenario, state).reasons).toContain(
    'debug_score_missing_current_run',
  );
  state.debugScore.lastRun.programRevision = 2;
  state.debugScore.lastRun.turns = 5;
  state.debugScore.lastRun.score = 5;
  expect(gradeWorkspaceOutcome(scenario, state).reasons).toContain(
    'debug_score_observed_run_mismatch',
  );
  state.debugScore.lastRun = null;
  expect(gradeWorkspaceOutcome(scenario, state).reasons).toContain(
    'debug_score_missing_current_run',
  );
  delete state.debugScore;
  expect(gradeWorkspaceOutcome(scenario, state).reasons).toContain('missing_debug_score_state');
});

it('rejects unsupported executable blocks and bounds the score program', () => {
  const state = createScoreState(true);
  expect(
    WorkspaceStateSchema.safeParse({
      ...state,
      debugScore: {
        blocks: [{ kind: 'executeJavaScript', source: 'score = 3' }],
        programRevision: 0,
        lastRun: null,
      },
    }).success,
  ).toBe(false);
  expect(
    WorkspaceStateSchema.safeParse({
      ...state,
      debugScore: {
        blocks: [
          {
            kind: DebugScoreBlockKind.REPEAT,
            turns: 21,
            body: [{ kind: DebugScoreBlockKind.INCREMENT_SCORE }],
          },
        ],
        programRevision: 0,
        lastRun: null,
      },
    }).success,
  ).toBe(false);
});

it('requires the expected task, reset trial and trusted target interaction', () => {
  const scenario = readCase(InteractiveTaskId.CLICK);
  const state = createState(InteractiveTaskId.CLICK);
  state.saved = true;
  expect(gradeWorkspaceOutcome(scenario, state, 'TrialOne')).toMatchObject({
    passed: false,
    outcomeMatches: true,
    trustedInteractionObserved: false,
  });
  recordClick(state, 'save-card');
  expect(gradeWorkspaceOutcome(scenario, state, 'TrialOne')).toEqual({
    passed: true,
    outcomeMatches: true,
    trustedInteractionObserved: true,
    reasons: [],
  });
  expect(gradeWorkspaceOutcome(scenario, state, 'DifferentReset').reasons).toContain('wrong_trial');
  state.taskId = InteractiveTaskId.TYPE;
  expect(gradeWorkspaceOutcome(scenario, state, 'TrialOne').reasons).toContain('wrong_task');
});

it('does not accept an unrelated click or unsupported event provenance', () => {
  const scenario = readCase(InteractiveTaskId.CLICK);
  const state = createState(InteractiveTaskId.CLICK);
  state.saved = true;
  recordClick(state, 'unrelated-control');
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(false);
  state.events = [
    { kind: WorkspaceEventKind.CLICK, targetId: 'save-card', trusted: false, elapsedMs: 100 },
  ];
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(false);
});

it('requires a completed drag and pointer lifecycle rather than a changed label alone', () => {
  const scenario = readCase(InteractiveTaskId.DRAG);
  const state = createState(InteractiveTaskId.DRAG);
  state.dropCompleted = true;
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(false);
  state.trustedEvents.pointerDown = 1;
  state.trustedEvents.pointerMove = 4;
  state.trustedEvents.pointerUp = 1;
  state.trustedEvents.drag = 1;
  state.events = [
    { kind: WorkspaceEventKind.DRAG, targetId: 'completed-area', trusted: true, elapsedMs: 100 },
  ];
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(true);
});

it('requires saved typed content and rejects typed-but-unsaved or wrong content', () => {
  const scenario = readCase(InteractiveTaskId.TYPE);
  const state = createState(InteractiveTaskId.TYPE);
  state.projectTitle = 'Solar Explorer';
  state.trustedEvents.input = 10;
  state.events.push({
    kind: WorkspaceEventKind.INPUT,
    targetId: 'project-title',
    trusted: true,
    elapsedMs: 50,
  });
  recordClick(state, 'save-project');
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(false);
  state.saved = true;
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(true);
  state.projectTitle = 'Wrong project';
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(false);
});

it('requires actual scrolling and a repaired validation outcome', () => {
  const scroll = createState(InteractiveTaskId.SCROLL);
  scroll.scrollConfirmed = true;
  recordClick(scroll, 'confirm-notes');
  expect(gradeWorkspaceOutcome(readCase(InteractiveTaskId.SCROLL), scroll).passed).toBe(false);
  scroll.scrollTop = 1200;
  expect(gradeWorkspaceOutcome(readCase(InteractiveTaskId.SCROLL), scroll).passed).toBe(true);

  const recovery = createState(InteractiveTaskId.RECOVERY);
  recovery.repeatCount = 3;
  recovery.saved = true;
  recovery.trustedEvents.input = 1;
  recovery.events.push({
    kind: WorkspaceEventKind.INPUT,
    targetId: 'repeat-count',
    trusted: true,
    elapsedMs: 50,
  });
  recordClick(recovery, 'save-repeat');
  expect(gradeWorkspaceOutcome(readCase(InteractiveTaskId.RECOVERY), recovery).passed).toBe(false);
  recovery.validationVisible = false;
  expect(gradeWorkspaceOutcome(readCase(InteractiveTaskId.RECOVERY), recovery).passed).toBe(true);
});

it('grades the history-dependent outcome without leaking its answer in the current page', () => {
  const scenario = readCase(InteractiveTaskId.HISTORY, 2);
  const state = createState(InteractiveTaskId.HISTORY);
  state.destination = WorkspaceDestination.BLUE;
  recordClick(state, 'blue-room');
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(false);
  state.destination = WorkspaceDestination.GREEN;
  recordClick(state, 'green-room');
  expect(gradeWorkspaceOutcome(scenario, state).passed).toBe(true);
  const html = createWorkspaceHtml({ taskId: InteractiveTaskId.HISTORY, trialId: 'TrialOne' });
  expect(html).not.toContain(scenario.historyText);
  expect(html).not.toContain('Teacher assignment observed earlier');
  expect(() =>
    createWorkspaceHtml({ taskId: InteractiveTaskId.CLICK, trialId: '<script>' }),
  ).toThrow();
});

it.each(Object.values(InteractiveTaskId).filter((task) => task !== InteractiveTaskId.DEBUG_PYTHON))(
  'renders a fresh %s fixture and rejects DOM-synthetic clicks as native evidence',
  async (taskId) => {
    const browser = new Window({
      width: 1024,
      height: 768,
      settings: { enableJavaScriptEvaluation: true },
    });
    try {
      browser.document.write(createWorkspaceHtml({ taskId, trialId: 'RenderedTrial' }));
      await browser.happyDOM.waitUntilComplete();
      const raw: unknown = browser.eval(readWorkspaceStateScript);
      const state = WorkspaceStateSchema.parse(raw);
      expect(state).toMatchObject({ taskId, trialId: 'RenderedTrial', firstEffectElapsedMs: null });
      expect(state.targets.length).toBeGreaterThan(0);
      expect(state.events).toEqual([]);
      const button = browser.document.querySelector('button');
      if (button) {
        button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
        const afterRaw: unknown = browser.eval(readWorkspaceStateScript);
        const after = WorkspaceStateSchema.parse(afterRaw);
        expect(after.trustedEvents.click).toBe(0);
        expect(
          after.events.some((event) => event.kind === WorkspaceEventKind.CLICK && !event.trusted),
        ).toBe(true);
        expect(gradeWorkspaceOutcome(readCase(taskId), after, 'RenderedTrial').passed).toBe(false);
      }
    } finally {
      await browser.happyDOM.close();
    }
  },
);

it('runs the initial buggy blocks and leaves them unchanged after synthetic edits or runs', async () => {
  const browser = new Window({
    width: 1024,
    height: 768,
    settings: { enableJavaScriptEvaluation: true },
  });
  try {
    browser.document.write(
      createWorkspaceHtml({ taskId: InteractiveTaskId.DEBUG_SCORE, trialId: 'DebugInitial' }),
    );
    await browser.happyDOM.waitUntilComplete();
    const initialRaw: unknown = browser.eval(readWorkspaceStateScript);
    const initial = WorkspaceStateSchema.parse(initialRaw);
    expect(initial.debugScore).toEqual({
      blocks: [
        {
          kind: DebugScoreBlockKind.REPEAT,
          turns: 3,
          body: [
            { kind: DebugScoreBlockKind.RESET_SCORE },
            { kind: DebugScoreBlockKind.INCREMENT_SCORE },
          ],
        },
      ],
      programRevision: 0,
      lastRun: { turns: 3, score: 1, programRevision: 0 },
    });
    expect(initial.scoreAfterThreeTurns).toBe(1);
    expect(browser.document.getElementById('score-program')?.textContent).toBe(
      'repeat 3 turns\n  set score to 0\n  change score by 1\nend repeat',
    );
    expect(browser.document.getElementById('score-result')?.textContent).toContain('score 1');
    const turns = browser.document.getElementById('score-turns');
    if (!(turns instanceof browser.HTMLInputElement)) {
      throw new Error('Missing score turns input.');
    }
    turns.value = '5';
    turns.dispatchEvent(new browser.Event('input', { bubbles: true }));
    for (const targetId of ['move-reset-before-loop', 'run-score']) {
      const button = browser.document.getElementById(targetId);
      if (!button) {
        throw new Error('Missing score control.');
      }
      button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    }
    const afterRaw: unknown = browser.eval(readWorkspaceStateScript);
    const after = WorkspaceStateSchema.parse(afterRaw);
    expect(after.debugScore).toEqual(initial.debugScore);
    expect(after.scoreAfterThreeTurns).toBe(1);
    expect(after.firstEffectElapsedMs).toBeNull();
    expect(after.trustedEvents.click).toBe(0);
    expect(after.trustedEvents.input).toBe(0);
    expect(gradeWorkspaceOutcome(readCase(InteractiveTaskId.DEBUG_SCORE), after).passed).toBe(
      false,
    );
  } finally {
    await browser.happyDOM.close();
  }
});

it('retains first target evidence after a pointer-move storm without upgrading synthetic events', async () => {
  const browser = new Window({
    width: 1024,
    height: 768,
    settings: { enableJavaScriptEvaluation: true },
  });
  try {
    browser.document.write(
      createWorkspaceHtml({ taskId: InteractiveTaskId.CLICK, trialId: 'PointerStorm' }),
    );
    await browser.happyDOM.waitUntilComplete();
    const button = browser.document.getElementById('save-card');
    if (!button) {
      throw new Error('Missing fixture button.');
    }
    button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    const firstRaw: unknown = browser.eval(readWorkspaceStateScript);
    const first = WorkspaceStateSchema.parse(firstRaw);
    const initialClick = first.events.find((event) => event.kind === WorkspaceEventKind.CLICK);
    expect(initialClick).toBeDefined();
    for (let index = 0; index < 200; index += 1) {
      button.dispatchEvent(
        new browser.PointerEvent('pointermove', { bubbles: true, clientX: index, clientY: 20 }),
      );
    }
    button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    const afterRaw: unknown = browser.eval(readWorkspaceStateScript);
    const after = WorkspaceStateSchema.parse(afterRaw);
    expect(after.events.find((event) => event.kind === WorkspaceEventKind.CLICK)).toEqual(
      initialClick,
    );
    expect(after.events.filter((event) => event.kind === WorkspaceEventKind.CLICK)).toHaveLength(1);
    expect(after.events.length).toBeLessThanOrEqual(WorkspaceObservationLimits.MAXIMUM_EVENTS);
    expect(after.trustedEvents.click).toBe(0);
    expect(after.events.every((event) => !event.trusted)).toBe(true);
    expect(
      gradeWorkspaceOutcome(readCase(InteractiveTaskId.CLICK), after, 'PointerStorm').passed,
    ).toBe(false);
  } finally {
    await browser.happyDOM.close();
  }
});
