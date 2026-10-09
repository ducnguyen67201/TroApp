import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { TeachingPresenter } from '../../../../src/desktop/worker/teaching/TeachingPresenter.js';
import { TeachingPresentationBudget } from '../../../../src/desktop/worker/teaching/TeachingPresentationBudget.js';
import { StudentInteractionTracker } from '../../../../src/desktop/worker/observation/StudentInteractionTracker.js';
import { createTeachingActionTargets } from '../../../../src/desktop/worker/teaching/TeachingActionTargets.js';
import { createLesson, bounds } from './TeachingTestFixture.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { TeachingMessage } from '#contracts/TeachingStep.js';

function setup() {
  const { lesson, proposal, capture } = createLesson();
  const log = pino({ level: 'silent' });
  const server = new LoggedCuaServer(
    { name: 'Unused presentation transport', command: 'unused' },
    log,
  );
  const tracker = new StudentInteractionTracker();
  const publish = vi.fn<(message: TeachingMessage) => void>();
  const prepare = vi.fn<(message: TeachingMessage) => void>();
  const revoke = vi.fn<(message: TeachingMessage) => void>();
  const presenter = new TeachingPresenter(
    lesson,
    server,
    tracker,
    new TeachingPresentationBudget(),
    log,
    publish,
    () => {},
    prepare,
    revoke,
  );
  presenter.beginSegment();
  return { lesson, proposal, capture, server, tracker, publish, prepare, revoke, presenter, log };
}

it.each([false, true])(
  'accepts a correlated native message/drawing acknowledgement with interrupted=%s',
  async (interrupted) => {
    const { lesson, proposal, server, tracker, publish, prepare, revoke, presenter } = setup();
    vi.spyOn(server, 'showTeachingCue').mockImplementation(async (args, message) => {
      await Promise.resolve();
      return {
        content: [],
        structuredContent: {
          status: 'presented',
          following: true,
          active: false,
          receipt: {
            presentation_version: 3,
            task_epoch: randomUUID(),
            sequence_id: randomUUID(),
            presentation_id: args['presentation_id'],
            lesson_id: message?.lessonId,
            step_id: message?.stepId,
            message_presented: true,
            drawing_presented: true,
            text_only: false,
            interrupted,
            strokes_presented: [
              {
                stroke_index: 0,
                trace_progress: interrupted ? 0.5 : 1,
                hold_ms_observed: interrupted ? 0 : 1100,
              },
            ],
          },
        },
      };
    });
    const receipt = await presenter.presentStep(proposal, DesktopLocale.ENGLISH);
    expect(receipt).toMatchObject({ admitted: true, drawingPresented: true, interrupted });
    expect(publish).toHaveBeenCalledTimes(interrupted ? 0 : 1);
    expect(revoke.mock.calls).toEqual(interrupted ? prepare.mock.calls : []);
    expect(lesson.readCurrentStep()?.receipt.presentationId).toBe(receipt['presentationId']);
    expect(tracker.readEvidence().expected).toEqual({ kind: 'click', target: bounds });
    const committedReceipt = presenter.readReceipt();
    presenter.endSegment();
    expect(presenter.readReceipt()).toEqual(committedReceipt);
    presenter.beginSegment();
    expect(presenter.readReceipt()).toBeNull();
  },
);
it.each(['old_animation_receipt', 'foreign_presentation', 'chat_only'])(
  'refuses %s before committing checkpoint or host instruction',
  async (variant) => {
    const { lesson, proposal, server, publish, prepare, revoke, presenter } = setup();
    vi.spyOn(server, 'showTeachingCue').mockImplementation(async (args, message) => {
      await Promise.resolve();
      return {
        content: [],
        structuredContent:
          variant === 'old_animation_receipt'
            ? {
                status: 'completed',
                following: true,
                active: false,
                receipt: {
                  presentation_version: 2,
                  task_epoch: randomUUID(),
                  sequence_id: randomUUID(),
                  completed_steps: 1,
                },
              }
            : {
                status: 'presented',
                following: true,
                active: false,
                receipt: {
                  presentation_version: 3,
                  task_epoch: randomUUID(),
                  sequence_id: randomUUID(),
                  presentation_id:
                    variant === 'foreign_presentation' ? randomUUID() : args['presentation_id'],
                  lesson_id: message?.lessonId,
                  step_id: message?.stepId,
                  message_presented: true,
                  drawing_presented: variant !== 'chat_only',
                  text_only: false,
                  interrupted: false,
                  strokes_presented: [
                    { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
                  ],
                },
              },
      };
    });
    expect(await presenter.presentStep(proposal, DesktopLocale.ENGLISH)).toMatchObject({
      admitted: false,
    });
    expect(lesson.readCurrentStep()).toBeNull();
    expect(prepare).toHaveBeenCalledOnce();
    expect(revoke.mock.calls).toEqual(prepare.mock.calls);
    expect(publish).not.toHaveBeenCalled();
  },
);
it('keeps drag source/destination matching independent of drawing geometry', () => {
  const destination = { ...bounds, x: 0.6 };
  const drag = createTeachingActionTargets({
    kind: 'drag',
    source: { label: 'Block', bounds },
    destination: { label: 'Workspace', bounds: destination },
  });
  expect(drag.targets).toEqual([bounds, destination]);
  expect(drag.interaction).toEqual({ kind: 'drag', source: bounds, destination });
  expect(
    createTeachingActionTargets({ kind: 'keyboard', shortcut: 'Command+Space' }).targets,
  ).toEqual([]);
});
it('uses one repair budget across mixed invalid, missing and refused presentation attempts', () => {
  const budget = new TeachingPresentationBudget();
  expect(budget.reject('invalid_tool_input')).toMatchObject({ repairsRemaining: 1 });
  expect(budget.reject('target_changed')).toMatchObject({ repairsRemaining: 0 });
  expect(() => budget.reject('missing_receipt')).toThrow('exhausted presentation repairs');
});

it('acknowledges explicit text-only steps and rejects a late receipt after Esc', async () => {
  const { lesson, proposal, server, tracker, publish, prepare, revoke } = setup();
  const stopped = new AbortController();
  const presenter = new TeachingPresenter(
    lesson,
    server,
    tracker,
    new TeachingPresentationBudget(),
    pino({ level: 'silent' }),
    publish,
    () => {
      stopped.signal.throwIfAborted();
    },
    prepare,
    revoke,
  );
  presenter.beginSegment();
  const showNativeCue: typeof server.showTeachingCue = async (args, message) => {
    await Promise.resolve();
    return {
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        receipt: {
          presentation_version: 3,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: false,
          text_only: true,
          interrupted: false,
          strokes_presented: [],
        },
      },
    };
  };
  const native = vi.spyOn(server, 'showTeachingCue').mockImplementation(showNativeCue);
  const keyboard = {
    ...proposal,
    action: { kind: 'keyboard' as const, shortcut: 'Command+Space' },
    drawing: null,
  };
  expect(await presenter.presentStep(keyboard, DesktopLocale.ENGLISH)).toMatchObject({
    admitted: true,
    textOnly: true,
  });
  expect(native.mock.calls[0]?.[0]).toMatchObject({ drawing: null, text_only: true });
  expect(revoke).not.toHaveBeenCalled();
  publish.mockClear();
  prepare.mockClear();
  const previous = lesson.readCurrentStep();
  native.mockImplementationOnce((args, message) => {
    stopped.abort();
    return showNativeCue(args, message);
  });
  await expect(presenter.presentStep(keyboard, DesktopLocale.ENGLISH)).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
  expect(lesson.readCurrentStep()).toEqual(previous);
  expect(revoke.mock.calls).toEqual(prepare.mock.calls);
});

it('revokes pending narration when the native presentation throws', async () => {
  const { proposal, server, prepare, revoke, presenter } = setup();
  vi.spyOn(server, 'showTeachingCue').mockRejectedValue(new Error('Transport failed'));
  await expect(presenter.presentStep(proposal, DesktopLocale.ENGLISH)).rejects.toThrow(
    'Transport failed',
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(revoke.mock.calls).toEqual(prepare.mock.calls);
});

it('logs correlated native coordinates without instruction text and preserves interrupted geometry', async () => {
  const { proposal, server, presenter, log } = setup();
  const info = vi.spyOn(log, 'info');
  const coordinateTrace = {
    requested_capture_id: proposal.captureId,
    capture_id: 'fresh-capture',
    screen_size_points: [1000, 500],
    capture_size_px: [2000, 1000],
    display_scale: 2,
    targets_normalized: [bounds],
    planned_strokes: [{ stroke_index: 0, cue_bounds_points: [100, 100, 300, 150] }],
    painted_strokes: [
      {
        stroke_index: 0,
        trace_progress: 0.5,
        geometry: {
          origin_points: [0, 0],
          backing_scale: 2,
          raster_size_px: [2000, 1000],
          cue_bounds_px: [200, 200, 600, 300],
          stroke_width_px: 6,
        },
      },
    ],
  };
  vi.spyOn(server, 'showTeachingCue').mockImplementation((args, message) =>
    Promise.resolve({
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        coordinate_trace: coordinateTrace,
        receipt: {
          presentation_version: 3,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: true,
          text_only: false,
          interrupted: true,
          strokes_presented: [{ stroke_index: 0, trace_progress: 0.5, hold_ms_observed: 0 }],
        },
      },
    }),
  );
  const result = await presenter.presentStep(proposal, DesktopLocale.ENGLISH);
  expect(result['admitted']).toBe(true);
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({
      presentationId: result['presentationId'],
      targetsNormalized: [bounds],
    }),
    'agent.teaching.coordinates.requested',
  );
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({
      presentationId: result['presentationId'],
      coordinateTrace,
      interrupted: true,
    }),
    'agent.teaching.coordinates.converted',
  );
  expect(JSON.stringify(info.mock.calls)).not.toContain(proposal.instruction);
  expect(JSON.stringify(info.mock.calls)).not.toContain(
    proposal.action.kind === 'click' ? proposal.action.target.label : 'never-log-this-label',
  );
});

it('ignores untrusted diagnostic fields without rejecting a valid drawing receipt', async () => {
  const { proposal, server, presenter, log } = setup();
  const info = vi.spyOn(log, 'info');
  vi.spyOn(server, 'showTeachingCue').mockImplementation((args, message) =>
    Promise.resolve({
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        coordinate_trace: { screenshot: 'private-pixels', instruction: 'private-text' },
        receipt: {
          presentation_version: 3,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: true,
          text_only: false,
          interrupted: false,
          strokes_presented: [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 }],
        },
      },
    }),
  );
  expect(await presenter.presentStep(proposal, DesktopLocale.ENGLISH)).toMatchObject({
    admitted: true,
  });
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({
      coordinateTrace: null,
      coordinateTraceAvailable: false,
    }),
    'agent.teaching.coordinates.converted',
  );
  expect(JSON.stringify(info.mock.calls)).not.toContain('private-');
});

it('presents a highlight directly from its observed bounds and a paired native receipt', async () => {
  const { lesson, proposal, server, presenter, tracker, publish } = setup();
  const highlight = {
    ...proposal,
    action: { kind: 'highlight' as const, target: { label: 'Requested area', bounds } },
  };
  const drawing = vi.spyOn(server, 'showTeachingCue').mockImplementation((args, message) =>
    Promise.resolve({
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        receipt: {
          presentation_version: 3,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: true,
          text_only: false,
          interrupted: false,
          strokes_presented: [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 }],
        },
      },
    }),
  );

  expect(await presenter.presentStep(highlight, DesktopLocale.ENGLISH)).toMatchObject({
    admitted: true,
    drawingPresented: true,
    textOnly: false,
  });
  expect(drawing).toHaveBeenCalledOnce();
  expect(drawing.mock.calls[0]?.[0]).toMatchObject({
    capture_id: proposal.captureId,
    targets: [bounds],
    text_only: false,
  });
  expect(drawing.mock.calls[0]?.[0]['drawing']).toEqual(proposal.drawing);
  expect(tracker.readEvidence().expected).toBeNull();
  expect(lesson.readCurrentStep()?.proposal.action).toEqual(highlight.action);
  expect(publish).toHaveBeenCalledOnce();
});

it.each(['stale_capture', 'missing_drawing'])(
  'refuses a highlight with %s without committing or publishing it',
  async (variant) => {
    const { lesson, proposal, capture, server, presenter, prepare, revoke, publish } = setup();
    const highlight = {
      ...proposal,
      action: { kind: 'highlight' as const, target: { label: 'Requested area', bounds } },
    };
    const drawing = vi.spyOn(server, 'showTeachingCue').mockImplementation((args, message) =>
      Promise.resolve({
        content: [],
        structuredContent: {
          status: 'presented',
          following: true,
          active: false,
          receipt: {
            presentation_version: 3,
            task_epoch: randomUUID(),
            sequence_id: randomUUID(),
            presentation_id: args['presentation_id'],
            lesson_id: message?.lessonId,
            step_id: message?.stepId,
            message_presented: true,
            drawing_presented: false,
            text_only: false,
            interrupted: false,
            strokes_presented: [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 }],
          },
        },
      }),
    );
    if (variant === 'stale_capture') {
      lesson.recordObservation(capture('new-capture'));
    }

    expect(await presenter.presentStep(highlight, DesktopLocale.ENGLISH)).toMatchObject({
      admitted: false,
      reason:
        variant === 'stale_capture' ? 'fresh_observation_required' : 'paired_presentation_missing',
    });
    expect(drawing).toHaveBeenCalledTimes(variant === 'stale_capture' ? 0 : 1);
    expect(prepare).toHaveBeenCalledTimes(variant === 'stale_capture' ? 0 : 1);
    expect(revoke.mock.calls).toEqual(prepare.mock.calls);
    expect(lesson.readCurrentStep()).toBeNull();
    expect(presenter.readReceipt()).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  },
);

it.each([
  {
    name: 'missing stroke',
    strokes: [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 }],
  },
  {
    name: 'foreign stroke',
    strokes: [
      { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
      { stroke_index: 2, trace_progress: 1, hold_ms_observed: 1100 },
    ],
  },
  {
    name: 'duplicate stroke',
    strokes: [
      { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
      { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
    ],
  },
  {
    name: 'incomplete reveal',
    strokes: [
      { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
      { stroke_index: 1, trace_progress: 0.9, hold_ms_observed: 1100 },
    ],
  },
  {
    name: 'insufficient hold',
    strokes: [
      { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
      { stroke_index: 1, trace_progress: 1, hold_ms_observed: 1099 },
    ],
  },
])('refuses $name evidence without committing a multi-stroke proposal', async ({ strokes }) => {
  const { lesson, proposal, server, presenter, publish, tracker } = setup();
  const drawing = {
    strokes: [
      {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.2, y: 0.2 },
        ],
        closed: false,
      },
      {
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.18, y: 0.18 },
        ],
        closed: false,
      },
    ],
  };
  vi.spyOn(server, 'showTeachingCue').mockImplementation((args, message) =>
    Promise.resolve({
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        receipt: {
          presentation_version: 3,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: true,
          text_only: false,
          interrupted: false,
          strokes_presented: strokes,
        },
      },
    }),
  );
  expect(
    await presenter.presentStep({ ...proposal, drawing }, DesktopLocale.ENGLISH),
  ).toMatchObject({ admitted: false });
  expect(lesson.readCurrentStep()).toBeNull();
  expect(publish).not.toHaveBeenCalled();
  expect(tracker.readEvidence().expected).toBeNull();
});

it('passes exact model strokes while matching student input only against action bounds', async () => {
  const { proposal, server, presenter, tracker } = setup();
  const drawing = {
    strokes: [
      {
        points: [
          { x: 0.7, y: 0.8 },
          { x: 0.9, y: 0.8 },
        ],
        closed: false,
      },
      {
        points: [
          { x: 0.9, y: 0.8 },
          { x: 0.85, y: 0.75 },
        ],
        closed: false,
      },
    ],
  };
  const native = vi.spyOn(server, 'showTeachingCue').mockImplementation((args, message) =>
    Promise.resolve({
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        receipt: {
          presentation_version: 3,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: true,
          text_only: false,
          interrupted: false,
          strokes_presented: [
            { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
            { stroke_index: 1, trace_progress: 1, hold_ms_observed: 1100 },
          ],
        },
      },
    }),
  );
  expect(
    await presenter.presentStep({ ...proposal, drawing }, DesktopLocale.ENGLISH),
  ).toMatchObject({ admitted: true });
  expect(native.mock.calls[0]?.[0]).toMatchObject({
    presentation_version: 3,
    drawing,
    targets: [bounds],
  });
  expect(native.mock.calls[0]?.[0]).not.toHaveProperty('steps');
  expect(tracker.readEvidence().expected).toEqual({ kind: 'click', target: bounds });
});

it('refuses invalid action/drawing agreement even before a direct host call stages narration', async () => {
  const { proposal, presenter, server, prepare, tracker } = setup();
  const native = vi.spyOn(server, 'showTeachingCue');
  expect(
    await presenter.presentStep({ ...proposal, drawing: null }, DesktopLocale.ENGLISH),
  ).toMatchObject({ admitted: false, reason: 'invalid_tool_input' });
  expect(native).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(tracker.readEvidence().expected).toBeNull();
});

function deferNativePresentations(server: LoggedCuaServer) {
  const replies: (() => void)[] = [];
  const native = vi.spyOn(server, 'showTeachingCue').mockImplementation(
    (args, message) =>
      new Promise<Awaited<ReturnType<LoggedCuaServer['showTeachingCue']>>>((resolve) => {
        replies.push(() => {
          resolve({
            content: [],
            structuredContent: {
              status: 'presented',
              following: true,
              active: false,
              receipt: {
                presentation_version: 3,
                task_epoch: randomUUID(),
                sequence_id: randomUUID(),
                presentation_id: args['presentation_id'],
                lesson_id: message?.lessonId,
                step_id: message?.stepId,
                message_presented: true,
                drawing_presented: true,
                text_only: false,
                interrupted: false,
                strokes_presented: [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 }],
              },
            },
          });
        });
      }),
  );
  return { native, replies };
}

it('closes pending ownership before a late native reply and does not commit or publish it', async () => {
  const { lesson, proposal, server, presenter, prepare, revoke, publish, tracker } = setup();
  const { replies } = deferNativePresentations(server);
  const pending = presenter.presentStep(proposal, DesktopLocale.ENGLISH);
  expect(prepare).toHaveBeenCalledOnce();
  presenter.endSegment();
  expect(revoke.mock.calls).toEqual(prepare.mock.calls);
  expect(tracker.readEvidence().expected).toBeNull();
  const reply = replies[0];
  if (!reply) {
    throw new Error('Pending native reply missing');
  }
  reply();
  expect(await pending).toEqual({ admitted: false, reason: 'presentation_superseded' });
  expect(lesson.readCurrentStep()).toBeNull();
  expect(presenter.readReceipt()).toBeNull();
  expect(publish).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledOnce();
});

it('a new segment fences the old reply without revoking or clearing the new pending step', async () => {
  const { lesson, proposal, server, presenter, prepare, revoke, publish, tracker } = setup();
  const { replies } = deferNativePresentations(server);
  const oldPending = presenter.presentStep(proposal, DesktopLocale.ENGLISH);
  presenter.endSegment();
  presenter.beginSegment();
  const newBounds = { ...bounds, x: 0.6 };
  const current = {
    ...proposal,
    action: { kind: 'click' as const, target: { label: 'Current target', bounds: newBounds } },
  };
  const newPending = presenter.presentStep(current, DesktopLocale.ENGLISH);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledTimes(1);
  const oldReply = replies[0];
  const newReply = replies[1];
  if (!oldReply || !newReply) {
    throw new Error('Deferred native replies missing');
  }
  oldReply();
  expect(await oldPending).toEqual({ admitted: false, reason: 'presentation_superseded' });
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(tracker.readEvidence().expected).toEqual({ kind: 'click', target: newBounds });
  expect(lesson.readCurrentStep()).toBeNull();
  expect(publish).not.toHaveBeenCalled();
  newReply();
  expect(await newPending).toMatchObject({ admitted: true });
  const committed = presenter.readReceipt();
  presenter.endSegment();
  expect(presenter.readReceipt()).toEqual(committed);
  expect(lesson.readCurrentStep()?.proposal.action).toEqual(current.action);
  expect(publish).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledTimes(1);
});

it('does not spend a repair budget or discard a committed receipt after its segment closes', async () => {
  const { lesson, proposal, server, presenter, publish } = setup();
  const { native, replies } = deferNativePresentations(server);
  const pending = presenter.presentStep(proposal, DesktopLocale.ENGLISH);
  const reply = replies[0];
  if (!reply) {
    throw new Error('Pending native reply missing');
  }
  reply();
  await pending;
  const receipt = presenter.readReceipt();
  const checkpoint = lesson.readCurrentStep();
  presenter.endSegment();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    expect(await presenter.presentStep(proposal, DesktopLocale.ENGLISH)).toEqual({
      admitted: false,
      reason: 'presentation_superseded',
    });
  }
  expect(native).toHaveBeenCalledOnce();
  expect(presenter.readReceipt()).toEqual(receipt);
  expect(lesson.readCurrentStep()).toEqual(checkpoint);
  expect(publish).toHaveBeenCalledOnce();
});

it('correlates a native refusal with the proposed capture, lesson and presentation', async () => {
  const { lesson, proposal, server, presenter, log } = setup();
  const warning = vi.spyOn(log, 'warn');
  const native = vi.spyOn(server, 'showTeachingCue').mockResolvedValue({
    isError: true,
    content: [],
    structuredContent: {
      status: 'refused',
      code: 'fresh_observation_required',
      reason: 'target_changed',
    },
  });
  await presenter.presentStep(proposal, DesktopLocale.ENGLISH);
  expect(warning).toHaveBeenCalledWith(
    expect.objectContaining({
      lessonId: lesson.id,
      captureId: proposal.captureId,
      goalRevisionId: proposal.goalRevisionId,
      presentationId: native.mock.calls[0]?.[0]['presentation_id'],
      reason: 'fresh_observation_required',
    }),
    'agent.teaching.presentation.refused',
  );
  expect(JSON.stringify(warning.mock.calls)).not.toContain(proposal.instruction);
});
