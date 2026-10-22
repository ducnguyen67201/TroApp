import { z } from 'zod';
import { ScratchProjectSchema } from './ScratchProject.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import { DesktopLocale, DesktopLocaleSchema } from '../../../src/contracts/DesktopLocale.js';
import { PythonDebugCase } from './PythonDebugCase.js';

export const InteractiveTaskId = {
  CLICK: 'Click',
  DRAG: 'Drag',
  TYPE: 'Type',
  SCROLL: 'Scroll',
  RECOVERY: 'Recovery',
  HISTORY: 'History',
  DEBUG_SCORE: 'DebugScore',
  DEBUG_PYTHON: 'DebugPython',
} as const;

export const WorkspaceDestination = { BLUE: 'Blue', GREEN: 'Green' } as const;

export const WorkspaceEventKind = {
  CLICK: 'click',
  POINTER_DOWN: 'pointerDown',
  POINTER_MOVE: 'pointerMove',
  POINTER_UP: 'pointerUp',
  INPUT: 'input',
  KEY_DOWN: 'keyDown',
  WHEEL: 'wheel',
  DRAG: 'drag',
} as const;

export const WorkspaceObservationLimits = { MAXIMUM_EVENTS: 96 } as const;

export const DebugScoreBlockKind = {
  RESET_SCORE: 'resetScore',
  INCREMENT_SCORE: 'incrementScore',
  REPEAT: 'repeat',
} as const;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const CounterSchema = z.number().int().nonnegative().max(10_000);
const ElapsedSchema = z
  .number()
  .nonnegative()
  .max(24 * 60 * 60 * 1000)
  .nullable();
const PointSchema = z.strictObject({ x: z.number(), y: z.number() });
const RectSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
const DebugScoreTurnsSchema = z.number().int().min(0).max(20);
const DebugScoreValueSchema = z.number().int().min(0).max(400);
const DebugScoreLeafSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(DebugScoreBlockKind.RESET_SCORE) }),
  z.strictObject({ kind: z.literal(DebugScoreBlockKind.INCREMENT_SCORE) }),
]);
const DebugScoreBlockSchema = z.union([
  DebugScoreLeafSchema,
  z.strictObject({
    kind: z.literal(DebugScoreBlockKind.REPEAT),
    turns: DebugScoreTurnsSchema,
    body: z.array(DebugScoreLeafSchema).min(1).max(4),
  }),
]);
const DebugScoreStateSchema = z.strictObject({
  blocks: z.array(DebugScoreBlockSchema).min(1).max(4),
  programRevision: CounterSchema,
  lastRun: z
    .strictObject({
      turns: DebugScoreTurnsSchema,
      score: DebugScoreValueSchema,
      programRevision: CounterSchema,
    })
    .nullable(),
});

/** Observations are bounded, test-only UI state. Rectangles use viewport CSS pixels,
 * not global desktop coordinates. Timing uses the renderer's own reset clock. */
export const WorkspaceStateSchema = z.strictObject({
  application: z.enum(EvaluationApplication).optional(),
  scratchProject: ScratchProjectSchema.nullable().optional(),
  scratchScore: z.number().nullable().optional(),
  pythonSource: z.string().max(16_384).nullable().optional(),
  pythonSourceChanged: z.boolean().optional(),
  pythonDebugged: z.boolean().optional(),
  schemaVersion: z.literal(1),
  taskId: z.enum(InteractiveTaskId),
  trialId: IdentifierSchema,
  saved: z.boolean(),
  dropCompleted: z.boolean(),
  projectTitle: z.string().max(120),
  scrollConfirmed: z.boolean(),
  scrollTop: z.number().nonnegative(),
  repeatCount: z.number().nullable(),
  validationVisible: z.boolean(),
  destination: z.enum(WorkspaceDestination).nullable(),
  debugScore: DebugScoreStateSchema.optional(),
  scoreAfterThreeTurns: DebugScoreValueSchema.nullable().optional(),
  trustedEvents: z.strictObject({
    click: CounterSchema,
    pointerDown: CounterSchema,
    pointerMove: CounterSchema,
    pointerUp: CounterSchema,
    input: CounterSchema,
    keyDown: CounterSchema,
    wheel: CounterSchema,
    drag: CounterSchema,
  }),
  lastPointer: PointSchema.nullable(),
  firstEffectElapsedMs: ElapsedSchema,
  lastEffectElapsedMs: ElapsedSchema,
  events: z
    .array(
      z.strictObject({
        kind: z.enum(WorkspaceEventKind),
        targetId: IdentifierSchema,
        trusted: z.boolean(),
        elapsedMs: z
          .number()
          .nonnegative()
          .max(24 * 60 * 60 * 1000),
      }),
    )
    .max(WorkspaceObservationLimits.MAXIMUM_EVENTS),
  viewport: z.strictObject({
    width: z.number().positive(),
    height: z.number().positive(),
    devicePixelRatio: z.number().positive(),
  }),
  targets: z
    .array(z.strictObject({ id: IdentifierSchema, label: z.string().max(120), bounds: RectSchema }))
    .max(12),
});

export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

const ExpectedStateSchema = z
  .strictObject({
    saved: z.boolean().optional(),
    dropCompleted: z.boolean().optional(),
    projectTitle: z.string().max(120).optional(),
    scrollConfirmed: z.boolean().optional(),
    repeatCount: z.number().optional(),
    validationVisible: z.boolean().optional(),
    destination: z.enum(WorkspaceDestination).optional(),
    scoreAfterThreeTurns: DebugScoreValueSchema.optional(),
    pythonDebugged: z.boolean().optional(),
  })
  .refine((state) => Object.keys(state).length > 0, 'An outcome predicate is required.');

export const InteractiveCaseSchema = z.strictObject({
  id: z.enum(InteractiveTaskId),
  title: z.string().min(1).max(160),
  request: z.string().min(1).max(1200),
  historyText: z.string().max(4000),
  locale: DesktopLocaleSchema.default(DesktopLocale.ENGLISH),
  expectedState: ExpectedStateSchema,
});

export type InteractiveCase = z.infer<typeof InteractiveCaseSchema>;

/** Seed cases measure native mechanics and model task completion, not student learning.
 * The history target alternates across repetitions while the current UI stays identical. */
export function createInteractiveCases(repetition: number): InteractiveCase[] {
  const trial = z.number().int().min(1).max(100).parse(repetition);
  const destination = trial % 2 === 1 ? WorkspaceDestination.BLUE : WorkspaceDestination.GREEN;
  return z.array(InteractiveCaseSchema).parse([
    {
      id: InteractiveTaskId.CLICK,
      title: 'Save a study card',
      request:
        'In the Tro evaluation workspace, click Save card. Confirm that the workspace says the card was saved. Stay inside this workspace.',
      historyText: 'The student is working on saving a study card.',
      expectedState: { saved: true },
    },
    {
      id: InteractiveTaskId.DRAG,
      title: 'Move a card into Completed',
      request:
        'In the Tro evaluation workspace, drag the Study card into the Completed area. Confirm that the card is marked completed. Stay inside this workspace.',
      historyText: 'The student is organizing a study card. The card should move into Completed.',
      expectedState: { dropCompleted: true },
    },
    {
      id: InteractiveTaskId.TYPE,
      title: 'Name and save a project',
      request:
        'In the Tro evaluation workspace, enter Solar Explorer as the project title and click Save project. Confirm that it was saved with that title. Stay inside this workspace.',
      historyText: 'The student is naming a project Solar Explorer.',
      expectedState: { projectTitle: 'Solar Explorer', saved: true },
    },
    {
      id: InteractiveTaskId.SCROLL,
      title: 'Read the end of a study panel',
      request:
        'In the Tro evaluation workspace, scroll inside the Study notes panel to its end, then click Confirm notes read. Confirm that the notes are marked read. Stay inside this workspace.',
      historyText: 'The study notes panel has more content below its visible area.',
      expectedState: { scrollConfirmed: true },
    },
    {
      id: InteractiveTaskId.RECOVERY,
      title: 'Repair a rejected repeat count',
      request:
        'In the Tro evaluation workspace, repair the visible repeat-count error by setting the count to 3, then click Save repeat count. Confirm that the error is gone and the count is saved. Stay inside this workspace.',
      historyText:
        'The repeat count was rejected because it was zero. Valid counts run from 1 to 5.',
      expectedState: { repeatCount: 3, saved: true, validationVisible: false },
    },
    {
      id: InteractiveTaskId.HISTORY,
      title: 'Resume the previously assigned room',
      request:
        'In the Tro evaluation workspace, continue to the room the teacher assigned earlier. Use the saved activity context if available. If the assignment is unavailable, ask which room was assigned; do not guess. Stay inside this workspace.',
      historyText: `Teacher assignment observed earlier: continue in the ${destination} room. This assignment is the relevant earlier instruction.`,
      expectedState: { destination },
    },
    {
      id: InteractiveTaskId.DEBUG_SCORE,
      title: 'Debug a score that resets each turn',
      request:
        'My score should go up by one each turn. After three turns it should be 3, but it shows 1. Help me debug this.',
      historyText: '',
      expectedState: { scoreAfterThreeTurns: 3 },
    },
    {
      id: InteractiveTaskId.DEBUG_PYTHON,
      title: 'Debug the missing greater-number branch in VS Code',
      request: PythonDebugCase.request,
      historyText: PythonDebugCase.historyText,
      locale: DesktopLocale.VIETNAMESE,
      expectedState: { pythonDebugged: true },
    },
  ]);
}

const WorkspacePageSchema = z.strictObject({
  taskId: z.enum(InteractiveTaskId),
  trialId: IdentifierSchema,
});

/** Static DOM readback is deliberately outside the model's tools. A new page per trial
 * resets outcomes, input evidence and clocks without touching any real user profile. */
export const readWorkspaceStateScript = `(() => {
  const element = document.getElementById('workspace-observation');
  if (!element) throw new Error('Workspace observation missing.');
  return JSON.parse(element.textContent || 'null');
})()`;

/** A standalone sandboxed fixture page with no preload, network or filesystem APIs.
 * Inline JavaScript is frozen fixture UI, not candidate code. Native event flags are
 * diagnostic evidence; they do not authenticate an OS driver or establish containment. */
export function createWorkspaceHtml(input: z.infer<typeof WorkspacePageSchema>): string {
  const page = WorkspacePageSchema.parse(input);
  if (page.taskId === InteractiveTaskId.DEBUG_PYTHON) {
    throw new Error('The Python debugging case requires the actual VS Code application.');
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Tro evaluation workspace</title>
<style>
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body { background: #eef3fa; color: #16304c; font: 20px system-ui, sans-serif; }
main { margin: 32px auto; padding: 30px; width: min(920px, calc(100% - 64px)); background: white; border: 2px solid #c6d4e5; border-radius: 20px; }
h1 { margin: 0 0 12px; font-size: 30px; } h2 { font-size: 24px; } p { line-height: 1.5; }
button { font: inherit; border: 2px solid #184c85; border-radius: 10px; color: white; background: #245f9e; padding: 16px 26px; cursor: pointer; }
button:focus-visible, input:focus-visible { outline: 4px solid #e3a900; outline-offset: 4px; }
input { display: block; width: min(580px, 100%); font: inherit; padding: 14px; border: 2px solid #7189a5; border-radius: 8px; margin: 14px 0 24px; }
label { display: block; font-weight: 600; } .status { min-height: 34px; margin-top: 24px; font-weight: 600; }
.error { color: #a52525; background: #fff0f0; padding: 12px; border-radius: 8px; }
.board { display: flex; gap: 100px; align-items: center; min-height: 280px; }
#study-card { width: 180px; height: 110px; display: grid; place-items: center; border: 3px solid #3d62a6; background: #edf2ff; border-radius: 12px; touch-action: none; user-select: none; cursor: grab; }
#study-card.dragging { cursor: grabbing; opacity: .65; }
#completed-area { width: 260px; height: 220px; border: 4px dashed #387b56; background: #edf9f1; border-radius: 16px; padding: 14px; text-align: center; }
#completed-area #study-card { margin: 18px auto; width: 180px; height: 100px; }
#notes-panel { height: 300px; overflow: auto; border: 3px solid #7189a5; border-radius: 10px; padding: 20px; overscroll-behavior: contain; }
#notes-panel p { margin: 0 0 42px; } .rooms { display: flex; gap: 36px; margin-top: 36px; }
#green-room { background: #236e4b; border-color: #185637; }
.score-controls { display: flex; flex-wrap: wrap; gap: 12px; margin: 18px 0; }
.score-controls button { font-size: 17px; padding: 12px 18px; }
#score-program { background: #fff0c2; border: 2px solid #aa7b13; border-radius: 10px; padding: 16px; line-height: 1.6; font: 20px monospace; }
#score-turns { width: 150px; display: inline-block; margin: 8px 18px 8px 0; }
#score-result { display: block; margin-top: 14px; font-weight: 600; }
</style></head><body><main>
<h1>Tro evaluation workspace</h1><div id="task-content"></div>
<p class="status" id="workspace-status" role="status" aria-live="polite"></p>
<output id="workspace-observation" hidden aria-hidden="true"></output>
</main><script>
(() => {
  'use strict';
  const taskId = ${JSON.stringify(page.taskId)};
  const trialId = ${JSON.stringify(page.trialId)};
  const startedAt = performance.now();
  const content = document.getElementById('task-content');
  const output = document.getElementById('workspace-observation');
  const status = document.getElementById('workspace-status');
  const state = {
    schemaVersion: 1, taskId, trialId, saved: false, dropCompleted: false,
    projectTitle: '', scrollConfirmed: false, scrollTop: 0, repeatCount: null,
    validationVisible: taskId === 'Recovery', destination: null,
    trustedEvents: { click: 0, pointerDown: 0, pointerMove: 0, pointerUp: 0, input: 0, keyDown: 0, wheel: 0, drag: 0 },
    lastPointer: null, firstEffectElapsedMs: null, lastEffectElapsedMs: null, events: [],
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, targets: []
  };
  const pages = {
    Click: '<h2>Study card</h2><p>Save this card to your study collection.</p><button id="save-card" data-target="Save card">Save card</button>',
    Drag: '<h2>Study board</h2><p>Cards can be dragged into the completed area.</p><div class="board"><div id="card-start"><div id="study-card" data-target="Study card">Study card</div></div><div id="completed-area" data-target="Completed area">Completed</div></div>',
    Type: '<h2>Project details</h2><label for="project-title">Project title</label><input id="project-title" data-target="Project title" maxlength="120" autocomplete="off" spellcheck="false"><button id="save-project" data-target="Save project">Save project</button>',
    Scroll: '<h2>Study notes</h2><div id="notes-panel" data-target="Study notes panel" tabindex="0"><p>These notes continue below the visible panel.</p>' + Array.from({ length: 12 }, (_, index) => '<p>Study note ' + (index + 1) + ': observe, predict and test your project carefully.</p>').join('') + '<button id="confirm-notes" data-target="Confirm notes read">Confirm notes read</button></div>',
    Recovery: '<h2>Repeat settings</h2><p id="repeat-error" class="error" role="alert">The count 0 was rejected. Enter a whole number from 1 to 5.</p><label for="repeat-count">Repeat count</label><input id="repeat-count" data-target="Repeat count" type="text" inputmode="numeric" maxlength="6" value="0" autocomplete="off"><button id="save-repeat" data-target="Save repeat count">Save repeat count</button>',
    History: '<h2>Continue your assignment</h2><p>Choose a room to continue.</p><div class="rooms"><button id="blue-room" data-target="Blue room">Blue room</button><button id="green-room" data-target="Green room">Green room</button></div>',
    DebugScore: '<h2>Score project</h2><p>The score should go up by one each turn.</p><pre id="score-program" data-target="Score blocks" aria-label="Current score blocks"></pre><div class="score-controls"><button id="move-reset-before-loop" data-target="Move reset before repeat">Move reset before repeat</button><button id="move-reset-inside-loop" data-target="Move reset into repeat">Move reset into repeat</button></div><label for="score-turns">Turns (0 to 20)</label><input id="score-turns" data-target="Turns" type="text" inputmode="numeric" maxlength="2" value="3" autocomplete="off"><button id="run-score" data-target="Run blocks">Run blocks</button><output id="score-result" data-target="Last run result" role="status" aria-live="polite"></output>'
  };
  content.innerHTML = pages[taskId];
  if (taskId === 'DebugScore') {
    state.debugScore = {
      blocks: [{ kind: 'repeat', turns: 3, body: [{ kind: 'resetScore' }, { kind: 'incrementScore' }] }],
      programRevision: 0,
      lastRun: null
    };
    state.scoreAfterThreeTurns = null;
  }
  const knownTargets = new Set(Array.from(document.querySelectorAll('[id]')).map((element) => element.id));
  knownTargets.add('Workspace');
  let drag = null;
  // This interpreter only accepts the fixture's bounded blocks; it never runs candidate source.
  function executeScoreBlocks() {
    let score = 0;
    let turns = 0;
    const runLeaf = (block) => {
      if (block.kind === 'resetScore') score = 0;
      if (block.kind === 'incrementScore') score += 1;
    };
    for (const block of state.debugScore.blocks) {
      if (block.kind === 'repeat') {
        turns = block.turns;
        for (let turn = 0; turn < block.turns; turn += 1) {
          for (const child of block.body) runLeaf(child);
        }
      } else {
        runLeaf(block);
      }
    }
    state.debugScore.lastRun = { turns, score, programRevision: state.debugScore.programRevision };
    state.scoreAfterThreeTurns = turns === 3 ? score : null;
    document.getElementById('score-result').textContent = 'Last run: ' + turns + ' turns; score ' + score + '.';
    return score;
  }
  function renderScoreBlocks() {
    const lines = [];
    const label = (block) => block.kind === 'resetScore' ? 'set score to 0' : 'change score by 1';
    for (const block of state.debugScore.blocks) {
      if (block.kind === 'repeat') {
        lines.push('repeat ' + block.turns + ' turns');
        for (const child of block.body) lines.push('  ' + label(child));
        lines.push('end repeat');
      } else {
        lines.push(label(block));
      }
    }
    document.getElementById('score-program').textContent = lines.join('\\n');
  }
  function reviseScoreBlocks(resetBeforeLoop, turns) {
    const reset = { kind: 'resetScore' };
    const increment = { kind: 'incrementScore' };
    const repeat = { kind: 'repeat', turns, body: resetBeforeLoop ? [increment] : [reset, increment] };
    state.debugScore.blocks = resetBeforeLoop ? [reset, repeat] : [repeat];
    state.debugScore.programRevision = Math.min(10000, state.debugScore.programRevision + 1);
    state.debugScore.lastRun = null;
    state.scoreAfterThreeTurns = null;
    document.getElementById('score-result').textContent = 'Blocks changed. Run blocks to see the score.';
    renderScoreBlocks();
  }
  function publish() {
    state.viewport = { width: innerWidth, height: innerHeight, devicePixelRatio };
    state.targets = Array.from(document.querySelectorAll('[data-target]')).slice(0, 12).map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.id, label: element.getAttribute('data-target') || '', bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    });
    output.textContent = JSON.stringify(state);
  }
  function effect(message) {
    const elapsed = performance.now() - startedAt;
    state.firstEffectElapsedMs = state.firstEffectElapsedMs === null ? elapsed : state.firstEffectElapsedMs;
    state.lastEffectElapsedMs = elapsed;
    status.textContent = message;
    publish();
  }
  function count(event, name, targetOverride) {
    const trusted = event.isTrusted === true;
    const element = event.target instanceof Element ? event.target.closest('[id]') : null;
    const observedTarget = targetOverride || (element && element.id) || 'Workspace';
    const targetId = knownTargets.has(observedTarget) ? observedTarget : 'Workspace';
    const previous = state.events.some((item) => item.kind === name && item.targetId === targetId && item.trusted === trusted);
    if (!previous) {
      // Preserve first semantic evidence even if later pointer motion is noisy.
      if (state.events.length >= ${String(WorkspaceObservationLimits.MAXIMUM_EVENTS)}) {
        const expendable = state.events.findIndex((item) => item.kind !== 'click' && item.kind !== 'input' && item.kind !== 'drag');
        if (expendable >= 0) state.events.splice(expendable, 1);
      }
      if (state.events.length < ${String(WorkspaceObservationLimits.MAXIMUM_EVENTS)}) {
        state.events.push({ kind: name, targetId, trusted, elapsedMs: performance.now() - startedAt });
      }
    }
    if (trusted) state.trustedEvents[name] = Math.min(10000, state.trustedEvents[name] + 1);
    publish();
    return trusted;
  }
  document.addEventListener('pointerdown', (event) => {
    if (!count(event, 'pointerDown')) return;
    state.lastPointer = { x: event.clientX, y: event.clientY };
    if (taskId === 'Drag' && event.button === 0 && event.target.closest('#study-card')) {
      drag = { x: event.clientX, y: event.clientY, moved: false };
      document.getElementById('study-card').classList.add('dragging');
    }
    publish();
  });
  document.addEventListener('pointermove', (event) => {
    if (!count(event, 'pointerMove')) return;
    state.lastPointer = { x: event.clientX, y: event.clientY };
    if (drag && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 12) drag.moved = true;
    publish();
  });
  document.addEventListener('pointerup', (event) => {
    if (!count(event, 'pointerUp')) return;
    state.lastPointer = { x: event.clientX, y: event.clientY };
    if (drag) {
      const target = document.getElementById('completed-area');
      const rect = target.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      const card = document.getElementById('study-card');
      card.classList.remove('dragging');
      if (drag.moved && inside) {
        state.dropCompleted = true;
        count(event, 'drag', 'completed-area');
        target.append(card);
        effect('Study card completed.');
      }
      drag = null;
    }
    publish();
  });
  document.addEventListener('pointercancel', () => {
    drag = null;
    const card = document.getElementById('study-card');
    if (card) card.classList.remove('dragging');
  });
  document.addEventListener('keydown', (event) => { if (count(event, 'keyDown')) publish(); });
  document.addEventListener('wheel', (event) => { if (count(event, 'wheel')) publish(); }, { passive: true });
  document.addEventListener('input', (event) => {
    if (!count(event, 'input')) return;
    state.saved = false;
    if (event.target.id === 'project-title') {
      state.projectTitle = event.target.value.slice(0, 120);
      effect('Project title edited.');
    }
    if (event.target.id === 'repeat-count') {
      const value = Number(event.target.value);
      state.repeatCount = event.target.value.trim() && Number.isFinite(value) ? value : null;
      effect('Repeat count edited.');
    }
    if (event.target.id === 'score-turns') {
      const raw = event.target.value.trim();
      const turns = Number(raw);
      if (raw && Number.isInteger(turns) && turns >= 0 && turns <= 20) {
        const beforeLoop = state.debugScore.blocks[0].kind === 'resetScore';
        reviseScoreBlocks(beforeLoop, turns);
        effect('Turns edited: ' + turns + '.');
      } else {
        state.debugScore.lastRun = null;
        state.scoreAfterThreeTurns = null;
        effect('Enter a whole number of turns from 0 to 20.');
      }
    }
    publish();
  });
  document.addEventListener('click', (event) => {
    if (!count(event, 'click')) return;
    const button = event.target.closest('button');
    if (!button) { publish(); return; }
    if (button.id === 'save-card') { state.saved = true; effect('Study card saved.'); }
    if (button.id === 'save-project' && state.projectTitle.trim()) { state.saved = true; effect('Project saved: ' + state.projectTitle); }
    if (button.id === 'confirm-notes') {
      const panel = document.getElementById('notes-panel');
      const rect = button.getBoundingClientRect();
      const viewport = panel.getBoundingClientRect();
      if (panel.scrollTop > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom) {
        state.scrollConfirmed = true;
        effect('Study notes marked read.');
      }
    }
    if (button.id === 'save-repeat') {
      const value = state.repeatCount;
      const valid = value !== null && Number.isInteger(value) && value >= 1 && value <= 5;
      state.validationVisible = !valid;
      document.getElementById('repeat-error').hidden = valid;
      state.saved = valid;
      effect(valid ? 'Repeat count saved: ' + value : 'The repeat count is still invalid.');
    }
    if (button.id === 'blue-room' || button.id === 'green-room') {
      state.destination = button.id === 'blue-room' ? 'Blue' : 'Green';
      effect('Entered the ' + state.destination + ' room.');
    }
    if (button.id === 'move-reset-before-loop' || button.id === 'move-reset-inside-loop') {
      const repeat = state.debugScore.blocks.find((block) => block.kind === 'repeat');
      reviseScoreBlocks(button.id === 'move-reset-before-loop', repeat.turns);
      effect('Reset block moved.');
    }
    if (button.id === 'run-score') {
      const raw = document.getElementById('score-turns').value.trim();
      const turns = Number(raw);
      const repeat = state.debugScore.blocks.find((block) => block.kind === 'repeat');
      if (raw && Number.isInteger(turns) && turns >= 0 && turns <= 20 && turns === repeat.turns) {
        const score = executeScoreBlocks();
        effect('Blocks ran; score ' + score + '.');
      } else {
        effect('Enter a whole number of turns from 0 to 20 before running.');
      }
    }
    publish();
  });
  const panel = document.getElementById('notes-panel');
  if (panel) panel.addEventListener('scroll', () => { state.scrollTop = panel.scrollTop; publish(); }, { passive: true });
  addEventListener('resize', publish);
  if (taskId === 'DebugScore') {
    renderScoreBlocks();
    executeScoreBlocks();
  }
  publish();
})();
</script></body></html>`;
}

export interface WorkspaceOutcomeGrade {
  passed: boolean;
  outcomeMatches: boolean;
  trustedInteractionObserved: boolean;
  reasons: string[];
}

/* This independent evaluator reads the bounded AST, not the renderer's labels or
 * claimed result. Counterfactual turn counts distinguish a general repair from
 * hard-coding a score of three. Nested loops and executable source are excluded. */
function calculateDebugScore(
  blocks: z.infer<typeof DebugScoreStateSchema>['blocks'],
  turns: number,
): number {
  let score = 0;
  const runLeaf = (block: z.infer<typeof DebugScoreLeafSchema>): void => {
    if (block.kind === DebugScoreBlockKind.RESET_SCORE) {
      score = 0;
    } else {
      score += 1;
    }
  };
  for (const block of blocks) {
    if (block.kind === DebugScoreBlockKind.REPEAT) {
      for (let turn = 0; turn < turns; turn += 1) {
        block.body.forEach(runLeaf);
      }
    } else {
      runLeaf(block);
    }
  }
  return score;
}

function findDebugScoreOutcomeFailures(state: WorkspaceState): string[] {
  const debugScore = state.debugScore;
  if (!debugScore) {
    return ['missing_debug_score_state'];
  }
  const reasons: string[] = [];
  const repeats = debugScore.blocks.filter((block) => block.kind === DebugScoreBlockKind.REPEAT);
  if (repeats.length !== 1 || repeats[0]?.turns !== 3) {
    reasons.push('debug_score_repeat_count_mismatch');
  }
  for (const turns of [0, 1, 3, 5]) {
    if (calculateDebugScore(debugScore.blocks, turns) !== turns) {
      reasons.push(`debug_score_behavior_mismatch:${String(turns)}`);
    }
  }
  const lastRun = debugScore.lastRun;
  if (!lastRun || lastRun.programRevision !== debugScore.programRevision) {
    reasons.push('debug_score_missing_current_run');
  } else if (
    lastRun.turns !== 3 ||
    lastRun.score !== 3 ||
    lastRun.score !== calculateDebugScore(debugScore.blocks, lastRun.turns)
  ) {
    reasons.push('debug_score_observed_run_mismatch');
  }
  return reasons;
}

/** An independently inspected state is necessary; the candidate's completion message
 * is never input. Trusted UI-event evidence rejects plain DOM .click() simulation,
 * but cannot by itself prove physical OS input or absence of malicious tampering. */
export function gradeWorkspaceOutcome(
  scenarioInput: InteractiveCase,
  stateInput: WorkspaceState,
  expectedTrialId?: string,
): WorkspaceOutcomeGrade {
  const scenario = InteractiveCaseSchema.parse(scenarioInput);
  const state = WorkspaceStateSchema.parse(stateInput);
  if (scenario.id === InteractiveTaskId.DEBUG_PYTHON) {
    return {
      passed: false,
      outcomeMatches: false,
      trustedInteractionObserved: false,
      reasons: ['python_case_requires_vscode_adapter'],
    };
  }
  const reasons: string[] = [];
  if (state.taskId !== scenario.id) {
    reasons.push('wrong_task');
  }
  if (expectedTrialId !== undefined && state.trialId !== expectedTrialId) {
    reasons.push('wrong_trial');
  }
  for (const [key, expected] of Object.entries(scenario.expectedState)) {
    const field = ExpectedStateSchema.keyof().parse(key);
    if (state[field] !== expected) {
      reasons.push(`outcome_mismatch:${key}`);
    }
  }
  if (scenario.id === InteractiveTaskId.DEBUG_SCORE) {
    reasons.push(...findDebugScoreOutcomeFailures(state));
  }
  const outcomeMatches = reasons.length === 0;
  const outcomeReasonCount = reasons.length;
  const hasEvent = (kind: WorkspaceState['events'][number]['kind'], targetId: string): boolean =>
    state.events.some(
      (event) => event.kind === kind && event.targetId === targetId && event.trusted,
    );
  if (scenario.id === InteractiveTaskId.DRAG) {
    if (
      !state.trustedEvents.drag ||
      !state.trustedEvents.pointerDown ||
      !state.trustedEvents.pointerMove ||
      !state.trustedEvents.pointerUp ||
      !hasEvent(WorkspaceEventKind.DRAG, 'completed-area')
    ) {
      reasons.push('missing_trusted_drag_evidence');
    }
  } else {
    const targets = {
      Click: 'save-card',
      Drag: 'completed-area',
      Type: 'save-project',
      Scroll: 'confirm-notes',
      Recovery: 'save-repeat',
      History: state.destination === WorkspaceDestination.BLUE ? 'blue-room' : 'green-room',
      DebugScore: 'run-score',
    };
    if (!state.trustedEvents.click || !hasEvent(WorkspaceEventKind.CLICK, targets[scenario.id])) {
      reasons.push('missing_trusted_click_evidence');
    }
  }
  if (
    scenario.id === InteractiveTaskId.DEBUG_SCORE &&
    (!state.trustedEvents.click || !hasEvent(WorkspaceEventKind.CLICK, 'move-reset-before-loop'))
  ) {
    reasons.push('missing_trusted_score_edit_evidence');
  }
  if (scenario.id === InteractiveTaskId.TYPE || scenario.id === InteractiveTaskId.RECOVERY) {
    const inputTarget = scenario.id === InteractiveTaskId.TYPE ? 'project-title' : 'repeat-count';
    if (!state.trustedEvents.input || !hasEvent(WorkspaceEventKind.INPUT, inputTarget)) {
      reasons.push('missing_trusted_input_evidence');
    }
  }
  if (scenario.id === InteractiveTaskId.SCROLL && state.scrollTop <= 0) {
    reasons.push('missing_scroll_effect');
  }
  return {
    passed: reasons.length === 0,
    outcomeMatches,
    trustedInteractionObserved: reasons.length === outcomeReasonCount,
    reasons,
  };
}
