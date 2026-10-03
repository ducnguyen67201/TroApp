import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { TeachingPresenter } from '../../../../src/desktop/worker/teaching/TeachingPresenter.js';
import { TeachingPresentationBudget } from '../../../../src/desktop/worker/teaching/TeachingPresentationBudget.js';
import { StudentInteractionTracker } from '../../../../src/desktop/worker/observation/StudentInteractionTracker.js';
import { createTeachingActionPresentation } from '../../../../src/desktop/worker/teaching/TeachingActionPresentation.js';
import { createLesson, bounds } from './TeachingTestFixture.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { TeachingMessage } from '#contracts/TeachingStep.js';

function setup() {
  const { lesson, proposal } = createLesson();
  const log = pino({ level: 'silent' });
  const server = new LoggedCuaServer(
    { name: 'Unused presentation transport', command: 'unused' },
    log,
  );
  const tracker = new StudentInteractionTracker();
  const publish = vi.fn<(message: TeachingMessage) => void>();
  const presenter = new TeachingPresenter(
    lesson,
    server,
    tracker,
    new TeachingPresentationBudget(),
    log,
    publish,
  );
  return { lesson, proposal, server, tracker, publish, presenter };
}

it.each([false, true])(
  'accepts a correlated native message/drawing acknowledgement with interrupted=%s',
  async (interrupted) => {
    const { lesson, proposal, server, tracker, publish, presenter } = setup();
    vi.spyOn(server, 'showTeachingCue').mockImplementation(async (args, message) => {
      await Promise.resolve();
      return {
        content: [],
        structuredContent: {
          status: 'presented',
          following: true,
          active: false,
          receipt: {
            presentation_version: 2,
            task_epoch: randomUUID(),
            sequence_id: randomUUID(),
            presentation_id: args['presentation_id'],
            lesson_id: message?.lessonId,
            step_id: message?.stepId,
            message_presented: true,
            drawing_presented: true,
            text_only: false,
            interrupted,
          },
        },
      };
    });
    const receipt = await presenter.presentStep(proposal, DesktopLocale.ENGLISH);
    expect(receipt).toMatchObject({ admitted: true, drawingPresented: true, interrupted });
    expect(publish).toHaveBeenCalledOnce();
    expect(lesson.readCurrentStep()?.receipt.presentationId).toBe(receipt['presentationId']);
    expect(tracker.readEvidence().expected).toEqual({ kind: 'click', target: bounds });
    presenter.beginSegment();
    expect(presenter.readReceipt()).toBeNull();
  },
);
it.each(['old_animation_receipt', 'foreign_presentation', 'chat_only'])(
  'refuses %s before committing checkpoint or host instruction',
  async (variant) => {
    const { lesson, proposal, server, publish, presenter } = setup();
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
                  presentation_version: 2,
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
                },
              },
      };
    });
    expect(await presenter.presentStep(proposal, DesktopLocale.ENGLISH)).toMatchObject({
      admitted: false,
    });
    expect(lesson.readCurrentStep()).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  },
);
it('generates a drag cue and the same source/destination matcher while keyboard steps are explicit', () => {
  const destination = { ...bounds, x: 0.6 };
  const drag = createTeachingActionPresentation({
    kind: 'drag',
    source: { label: 'Block', bounds },
    destination: { label: 'Workspace', bounds: destination },
  });
  expect(drag.steps.map((step) => step['kind'])).toEqual(['selection', 'drag', 'selection']);
  expect(drag.targets).toEqual([bounds, destination]);
  expect(drag.interaction).toEqual({ kind: 'drag', source: bounds, destination });
  expect(
    createTeachingActionPresentation({ kind: 'keyboard', shortcut: 'Command+Space' }).steps,
  ).toEqual([]);
});
it('uses one repair budget across mixed invalid, missing and refused presentation attempts', () => {
  const budget = new TeachingPresentationBudget();
  expect(budget.reject('invalid_tool_input')).toMatchObject({ repairsRemaining: 1 });
  expect(budget.reject('target_changed')).toMatchObject({ repairsRemaining: 0 });
  expect(() => budget.reject('missing_receipt')).toThrow('exhausted presentation repairs');
});

it('acknowledges explicit text-only steps and rejects a late receipt after Esc', async () => {
  const { lesson, proposal, server, tracker, publish } = setup();
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
  );
  const showNativeCue: typeof server.showTeachingCue = async (args, message) => {
    await Promise.resolve();
    return {
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        receipt: {
          presentation_version: 2,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: false,
          text_only: true,
          interrupted: false,
        },
      },
    };
  };
  const native = vi.spyOn(server, 'showTeachingCue').mockImplementation(showNativeCue);
  const keyboard = {
    ...proposal,
    action: { kind: 'keyboard' as const, shortcut: 'Command+Space' },
  };
  expect(await presenter.presentStep(keyboard, DesktopLocale.ENGLISH)).toMatchObject({
    admitted: true,
    textOnly: true,
  });
  expect(native.mock.calls[0]?.[0]).toMatchObject({ steps: [], text_only: true });
  publish.mockClear();
  const previous = lesson.readCurrentStep();
  native.mockImplementationOnce((args, message) => {
    stopped.abort();
    return showNativeCue(args, message);
  });
  await expect(presenter.presentStep(keyboard, DesktopLocale.ENGLISH)).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
  expect(lesson.readCurrentStep()).toEqual(previous);
});
