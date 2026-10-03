import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { AgentChatController } from '../../../../../src/desktop/main/AgentChatController.js';
import { AgentWorkerClient } from '../../../../../src/desktop/main/AgentWorkerClient.js';
import { executeAgentCommand } from '../../../../../src/desktop/main/ExecuteAgentCommand.js';
import type { AgentChatAuth } from '../../../../../src/desktop/main/AgentChatPorts.js';
import { CompanionHudController } from '../../../../../src/desktop/main/companion/CompanionHudController.js';
import type { CompanionHudSnapshot } from '../../../../../src/contracts/CompanionHud.js';
import type { AgentProgress } from '../../../../../src/contracts/CompanionHud.js';
import { FlowScenario, TeachingFlowFixture } from './TeachingFlowFixture.js';
import { checkNativeTeachingBoundary } from './CheckNativeTeachingBoundary.js';

const root = z.string().parse(process.argv[2]);
const nodeExecutable = z.string().parse(process.argv[3]);
app.setPath('userData', join(root, 'profile'));
const fixture = new TeachingFlowFixture();
let window: BrowserWindow | null = null;
let chat: AgentChatController | null = null;
const progress: AgentProgress[] = [];
const hudSnapshots: CompanionHudSnapshot[] = [];
const hud = new CompanionHudController(
  {
    showSnapshot: (snapshot) => {
      hudSnapshots.push(snapshot);
    },
  },
  {
    now: () => performance.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
  },
);
const stateSchema = z.strictObject({
  ready: z.string(),
  sending: z.string(),
  phase: z.string(),
  outcome: z.string(),
  step: z.string(),
});
const deadline = setTimeout(() => {
  console.error('FAIL teaching contract: overall deadline exceeded.');
  chat?.dispose();
  app.exit(1);
}, 120000);

async function checkPresentationContract(): Promise<void> {
  await beginLesson(FlowScenario.CHAT_ONLY);
  await waitForState('chat-only repair draws before waiting', (state) => state.phase === 'waiting');
  assert.equal(fixture.segments, 2);
  assert.equal(fixture.previews, 1);
  fixture.changeScreen('youtube');
  await waitForState(
    'repaired presentation completes',
    (state) => state.outcome === 'goal_reached',
  );

  await assertCleanup();
  await beginLesson(FlowScenario.CHAT_ONLY_AFTER_STEP);
  await waitForState('initial presentation receipt', (state) => state.phase === 'waiting');
  fixture.changeScreen('browser');
  await waitForState('bounded missing presentation failure', (state) => state.outcome === 'failed');
  assert.equal(
    fixture.segments,
    4,
    'An old drawing must not authorize chat-only waiting; two repairs are allowed.',
  );
  assert.equal(fixture.previews, 1);
  await assertCleanup();
  console.info(
    'PASS presentation contract: missing tool is repaired; an older drawing cannot authorize chat-only spatial guidance.',
  );
}

async function readState(): Promise<z.infer<typeof stateSchema>> {
  assert.ok(window);
  const raw: unknown = await window.webContents.executeJavaScript(`(() => {
    const element = document.getElementById('contract-state');
    if (!element) return {ready:'false',sending:'false',phase:'',outcome:'',step:''};
    return {...element.dataset};
  })()`);
  return stateSchema.parse(raw);
}

async function waitForState(
  label: string,
  check: (state: z.infer<typeof stateSchema>) => boolean,
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 15000) {
    if (fixture.failure) {
      throw fixture.failure;
    }
    if (check(await readState())) {
      return;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out at ${label}; segments=${String(fixture.segments)}, captures=${String(fixture.captures)}, previews=${String(fixture.previews)}.`,
  );
}

async function clickControl(id: 'contract-start' | 'contract-answer'): Promise<void> {
  assert.ok(window);
  await window.webContents.executeJavaScript(`document.getElementById('${id}').click()`);
}

async function beginLesson(scenario: FlowScenario): Promise<void> {
  fixture.reset(scenario, 'Open YouTube, contract goal.');
  progress.length = 0;
  await clickControl('contract-start');
}

async function waitForWaiting(segment: number): Promise<void> {
  await waitForState(
    `waiting after segment ${String(segment)}`,
    (state) => state.phase === 'waiting' && fixture.segments === segment,
  );
  assert.equal(
    (await readState()).sending,
    'true',
    'A cue must leave the original request pending.',
  );
}

async function assertCleanup(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fixture.watchStarts === fixture.watchEnds && fixture.epochStarts === fixture.epochEnds) {
      break;
    }
    await delay(50);
  }
  fixture.assertReleased();
}

async function checkJourney(): Promise<void> {
  await beginLesson(FlowScenario.JOURNEY);
  await waitForWaiting(1);
  const requestCount = fixture.requests;
  await delay(800);
  assert.equal(fixture.requests, requestCount, 'Idle waiting must not request the model.');
  // Pointer movement alone does not increment either native revision.
  await delay(300);
  assert.equal(fixture.requests, requestCount, 'Pointer movement must not wake the model.');
  fixture.changeScreen('wrong_app');
  await waitForWaiting(2);
  assert.equal(
    (await readState()).outcome,
    '',
    'Opening a wrong app cannot finish or cancel the goal.',
  );
  fixture.changeScreen('browser', true, true);
  const draggingRequests = fixture.requests;
  await delay(700);
  assert.equal(
    fixture.requests,
    draggingRequests,
    'A held drag must settle before another SDK run.',
  );
  fixture.releaseButtons();
  await waitForWaiting(3);
  assert.match((await readState()).step, /address bar/);
  const previews = fixture.previews;
  fixture.changeScreen('focused');
  await waitForWaiting(4);
  const typingMessage = hudSnapshots.at(-1)?.message;
  assert.ok(typingMessage);
  assert.equal(fixture.previews, previews, 'Focused typing requires no new circle.');
  fixture.changeScreen('partial');
  await waitForWaiting(5);
  assert.equal(hudSnapshots.at(-1)?.message?.stepId, typingMessage.stepId);
  assert.equal(fixture.previews, previews, 'Partial typing must not replay a cue.');
  assert.ok(chat);
  const activeSession = progress.at(-1)?.sessionId;
  assert.ok(activeSession);
  await chat.updateTeachingLocale(activeSession, 'en');
  await waitForState(
    'locale translation',
    () =>
      hudSnapshots.at(-1)?.locale === 'en' &&
      hudSnapshots.at(-1)?.message?.text === 'Type youtube.com, then press Enter.',
  );
  fixture.changeScreen('loading');
  await waitForWaiting(6);
  assert.equal(hudSnapshots.at(-1)?.message?.stepId, typingMessage.stepId);
  assert.equal(fixture.previews, previews);
  fixture.changeScreen('youtube', false);
  await waitForState(
    'goal completion after bounded input-linked loading check',
    (state) => state.outcome === 'goal_reached' && state.sending === 'false',
  );
  assert.equal(fixture.segments, 7);
  assert.equal(hudSnapshots.at(-1)?.message?.kind, 'completion');
  const lessonIds = new Set(progress.flatMap((item) => (item.lessonId ? [item.lessonId] : [])));
  assert.equal(lessonIds.size, 1, 'All guidance must belong to one lesson.');
  await assertCleanup();
  console.info(
    'PASS journey: observe → cue → wrong app → drag settles → next cue → visual goal verification; idle uses zero model requests.',
  );
}

async function checkQuestion(): Promise<void> {
  await beginLesson(FlowScenario.QUESTION);
  await waitForState('question', (state) => state.phase === 'needs_input');
  const question = progress.find((item) => item.phase === 'needs_input');
  assert.ok(question?.lessonId);
  assert.ok(chat);
  const stale = await chat.answerLesson(question.sessionId, randomUUID(), 'Chrome', 'vi');
  assert.equal(stale.kind, 'failed', 'Answers from an old lesson must be rejected.');
  await clickControl('contract-answer');
  await waitForWaiting(2);
  fixture.changeScreen('youtube');
  await waitForState(
    'question continuation completes',
    (state) => state.outcome === 'goal_reached' && state.sending === 'false',
  );
  await assertCleanup();
  console.info('PASS question: scoped answer resumes the same goal; stale answer rejected.');
}

async function pressEscapeAndCheckCleanup(): Promise<void> {
  assert.ok(window);
  await window.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`,
  );
  await waitForState(
    'renderer Escape cleanup',
    (state) => state.sending === 'false' && state.phase === '' && state.step === '',
  );
  await assertCleanup();
  const count = fixture.requests;
  fixture.changeScreen('youtube');
  await delay(600);
  assert.equal(fixture.requests, count, 'A stopped lesson must not resume on later changes.');
}

async function checkEscape(): Promise<void> {
  await beginLesson(FlowScenario.JOURNEY);
  await waitForWaiting(1);
  await pressEscapeAndCheckCleanup();
  await beginLesson(FlowScenario.MODEL_PENDING);
  await waitForState('model HTTP request in flight', () => fixture.modelPending);
  await pressEscapeAndCheckCleanup();
  console.info(
    'PASS Escape: waiting and in-flight SDK request both cancel through renderer/preload/main/worker; later changes stay stopped.',
  );
}

async function checkStaleCompletion(): Promise<void> {
  await beginLesson(FlowScenario.STALE_COMPLETION);
  await waitForWaiting(2);
  assert.equal(
    (await readState()).outcome,
    '',
    'A reached-goal reply from a stale screen must not finish the task.',
  );
  fixture.changeScreen('youtube');
  await waitForState(
    'fresh completion after rejecting stale output',
    (state) => state.outcome === 'goal_reached' && state.sending === 'false',
  );
  await assertCleanup();
  console.info(
    'PASS freshness: a screen change during SDK completion forces observation again before success.',
  );
}

async function checkBackgroundAnimation(): Promise<void> {
  await beginLesson(FlowScenario.BACKGROUND_ANIMATION);
  await waitForWaiting(1);
  assert.equal(
    fixture.previews,
    1,
    'A stable cue target must be displayed despite other animation.',
  );
  assert.equal(fixture.segments, 1, 'Background revisions must not discard a displayed cue.');
  const requests = fixture.requests;
  await delay(1200);
  assert.equal(fixture.requests, requests, 'No repeated model work before another change.');
  fixture.changeScreen('youtube');
  await waitForState(
    'goal after background animation',
    (state) => state.outcome === 'goal_reached' && state.sending === 'false',
  );
  await assertCleanup();
  console.info(
    'PASS background animation: locally validated cue displays once; the same goal continues.',
  );
}

async function checkTargetRecovery(): Promise<void> {
  await beginLesson(FlowScenario.STALE_PREVIEW);
  await waitForWaiting(1);
  assert.equal(fixture.previews, 1);
  assert.equal(fixture.segments, 1, 'A target refusal is repair feedback within the same SDK run.');
  assert.ok(fixture.requests >= 4, 'The model must receive and repair the failed presentation.');
  fixture.changeScreen('youtube');
  await waitForState(
    'repaired target completes original goal',
    (state) => state.outcome === 'goal_reached',
  );
  await assertCleanup();
  await beginLesson(FlowScenario.INPUT_DURING_PROPOSAL);
  await waitForWaiting(4);
  assert.equal(fixture.previews, 1, 'Only the current proposal may play.');
  assert.equal(
    progress.some((item) => item.phase === 'paused'),
    false,
    'Student input does not spend the stale-target repair budget.',
  );
  fixture.changeScreen('youtube');
  await waitForState(
    'input during inference resumes original goal',
    (state) => state.outcome === 'goal_reached',
  );
  await assertCleanup();
  console.info(
    'PASS target/input recovery: ordinary mismatch preserves SDK context; repeated real input resumes without an unstable-screen pause.',
  );
}

async function checkFailures(): Promise<void> {
  await beginLesson(FlowScenario.REFRESH_FAILURE);
  await waitForState(
    'native cue refresh failure',
    (state) => state.outcome === 'failed' && state.sending === 'false',
  );
  assert.equal(fixture.segments, 1, 'Native refresh failure cannot start a stale recovery loop.');
  assert.equal(fixture.requests, 2, 'Native failure aborts the SDK before another model request.');
  assert.equal(fixture.previews, 0);
  await assertCleanup();
  console.info(
    'PASS cue refresh failure: one segment, typed diagnostic, no playback or model retry.',
  );

  await beginLesson(FlowScenario.BAD_RECEIPT);
  await waitForState(
    'receipt failure',
    (state) => state.outcome === 'failed' && state.sending === 'false',
  );
  await assertCleanup();
  assert.equal(fixture.previews, 1);
  console.info('PASS receipt: a foreign epoch cannot acknowledge a demonstration.');
  await beginLesson(FlowScenario.WATCH_FAILURE);
  await waitForState(
    'watch failure',
    (state) => state.outcome === 'failed' && state.sending === 'false',
  );
  assert.equal(fixture.requests, 0, 'A watch admission failure must prevent model dispatch.');
  await assertCleanup();
  console.info('PASS watch failure: typed failure reaches the renderer without model dispatch.');
}

async function runContract(): Promise<void> {
  await app.whenReady();
  if (process.argv.includes('--native')) {
    await checkNativeTeachingBoundary();
  } else {
    console.info(
      'NOT VERIFIED: native capture, physical input hooks, and visible cue rendering. Run pnpm test:teaching:native and the manual acceptance flow.',
    );
  }
  await fixture.start();
  const auth: AgentChatAuth = {
    readSession: () =>
      Promise.resolve({
        kind: 'signed-in',
        user: { id: 'contract', name: 'Contract', email: 'contract@example.test' },
      }),
    signInWithGoogle: () =>
      Promise.resolve({
        kind: 'failed',
        message: 'Contract has no external sign-in.',
      }),
    signOut: () => Promise.resolve({ kind: 'signed-out' }),
    fetchModelCredential: () =>
      Promise.resolve({
        token: 'local-contract-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
  };
  const worker = new AgentWorkerClient(
    join(root, 'main', 'StartAgentWorker.js'),
    false,
    {
      start: () =>
        Promise.resolve({
          command: nodeExecutable,
          args: [join(root, 'main', 'TeachingMcpFixture.js'), fixture.url],
          env: {},
        }),
    },
    '33333333-3333-4333-8333-333333333333',
    (event) => {
      progress.push(event);
      hud.receiveProgress(event);
      chat?.receiveProgress(event);
      window?.webContents.send('tro:agent-progress', event);
    },
  );
  chat = new AgentChatController(auth, worker, `${fixture.url}/v1`, {
    readStatus: () =>
      Promise.resolve({
        kind: 'ready',
        accessibility: 'granted',
        screenRecording: 'granted',
      }),
  });
  const documentUrl = pathToFileURL(join(root, 'renderer', 'index.html')).href;
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(root, 'preload', 'Preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ipcMain.handle('tro:auth-command', async (event, command: unknown) => {
    assert.equal(event.sender, window?.webContents);
    z.strictObject({ kind: z.literal('status') }).parse(command);
    return auth.readSession();
  });
  ipcMain.handle('tro:agent-command', async (event, command: unknown) => {
    assert.ok(chat);
    assert.equal(event.sender, window?.webContents);
    assert.equal(event.senderFrame, window?.webContents.mainFrame);
    assert.equal(event.senderFrame.url, documentUrl);
    return executeAgentCommand(command, {
      chat,
      startFollowing: () => Promise.resolve({ kind: 'stopped' }),
      canSendMessage: () => true,
      startTask: (sessionId, locale) => {
        hud.startTask(sessionId, locale);
      },
      finishTask: (result, sessionId) => {
        hud.finishTask(result, sessionId);
      },
      cancelPresentation: () => {
        hud.reset();
      },
    });
  });
  await window.loadURL(documentUrl);
  await waitForState('renderer authentication', (state) => state.ready === 'true');
  await checkJourney();
  await checkPresentationContract();
  await checkQuestion();
  await checkStaleCompletion();
  await checkBackgroundAnimation();
  await checkTargetRecovery();
  await checkEscape();
  await checkFailures();
}

void runContract()
  .then(
    () => 0,
    (error: unknown) => {
      // Only fixture assertions are printed. Never print IPC/model request bodies.
      console.error(
        `FAIL teaching contract: ${error instanceof Error ? error.message : 'Unknown contract failure.'}`,
      );
      return 1;
    },
  )
  .then(async (code) => {
    clearTimeout(deadline);
    chat?.dispose();
    window?.destroy();
    await fixture.close();
    app.exit(code);
  });
