import { MCPServerStdio, RunContext, type CallToolResult } from '@openai/agents';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CursorCompanionTool } from '#contracts/CursorCompanion.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { DesktopObservation } from '#contracts/DesktopObservation.js';
import { CuaCompanionClient } from '../../../../src/desktop/worker/cua/CuaCompanionClient.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { runComputerUseAgent } from '../../../../src/desktop/worker/agent/RunComputerUseAgent.js';
import type { DesktopObservationPort } from '../../../../src/desktop/worker/observation/DesktopObservationClient.js';
import {
  TeachingTaskRunner,
  type ReceiveTeachingStep,
} from '../../../../src/desktop/worker/teaching/TeachingTaskRunner.js';
import { TeachingPresenter } from '../../../../src/desktop/worker/teaching/TeachingPresenter.js';
import { TeachingPresentationBudget } from '../../../../src/desktop/worker/teaching/TeachingPresentationBudget.js';
import { TeachingLessonContext } from '../../../../src/desktop/worker/teaching/TeachingLessonContext.js';

function deferValue<Value>() {
  let complete: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      if (!complete) {
        throw new Error('Deferred value was not initialized');
      }
      complete(value);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([0, 1])(
  'fences a delayed observation callback after segment closure with input revision %s',
  async (inputRevision) => {
    const snapshot: DesktopObservation = {
      watch_id: '11111111-1111-4111-8111-111111111111',
      screen_revision: 1,
      input_revision: 0,
      ready: true,
      changed_fraction: 0,
      quiet_ms: 1000,
      buttons_down: false,
      screen_width: 1000,
      screen_height: 800,
    };
    const read = vi.fn<DesktopObservationPort['read']>().mockResolvedValue(snapshot);
    const observation: DesktopObservationPort = {
      begin: vi.fn<DesktopObservationPort['begin']>().mockResolvedValue(undefined),
      read,
      recordCapture: vi.fn<DesktopObservationPort['recordCapture']>(),
      readBaseline: () => snapshot,
      end: vi.fn<DesktopObservationPort['end']>().mockResolvedValue(undefined),
    };
    vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockImplementation(
      async (name, args): Promise<CallToolResult> => {
        await Promise.resolve();
        if (name === 'get_desktop_state') {
          return {
            content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
            structuredContent: {
              capture_id: 'current-capture',
              display: 'primary',
              screen_width: 1000,
              screen_height: 800,
              screenshot_width: 1000,
              screenshot_height: 800,
              scale_factor: 1,
            },
          };
        }
        if (name === CursorCompanionTool.READ_CAPABILITIES) {
          return {
            content: [],
            structuredContent: {
              presentation_versions: [3],
              task_lifecycle: true,
              paired_presentation: true,
              display_scope: 'primary',
              gestures: ['scribble'],
              max_strokes: 3,
              max_points_per_stroke: 32,
              max_duration_ms: 15000,
            },
          };
        }
        if (name === CursorCompanionTool.BEGIN_TASK || name === CursorCompanionTool.END_TASK) {
          return {
            content: [],
            structuredContent: {
              status: name === CursorCompanionTool.BEGIN_TASK ? 'task_ready' : 'task_ended',
              task_epoch: args?.task_epoch,
              following: true,
              active: false,
            },
          };
        }
        return {
          content: [],
          structuredContent: {
            status: args?.mode === 'hidden' ? 'hidden' : 'following',
            following: args?.mode !== 'hidden',
            active: false,
          },
        };
      },
    );
    const log = pino({ level: 'silent' });
    const server = new LoggedCuaServer({ name: 'Segment fence test', command: 'unused' }, log);
    const companion = new CuaCompanionClient(server);
    const delayedObservation = deferValue<DesktopObservation>();
    const readStarted = deferValue<true>();
    let pendingPresentation: Promise<unknown> | undefined;
    let closedPresentationTool: ((input: string) => Promise<unknown>) | undefined;
    const begin = vi.spyOn(TeachingPresenter.prototype, 'beginSegment');
    const present = vi.spyOn(TeachingPresenter.prototype, 'presentStep');
    const history = vi.spyOn(TeachingLessonContext.prototype, 'recordOperation');
    const repairs = vi.spyOn(TeachingPresentationBudget.prototype, 'reject');
    const receiveStep = vi.fn<ReceiveTeachingStep>();
    const runAgent = vi.fn<typeof runComputerUseAgent>().mockImplementation(async (agent) => {
      const defineGoal = agent.tools.find((entry) => entry.name === 'define_teaching_goal');
      const presentStep = agent.tools.find((entry) => entry.name === 'present_teaching_step');
      if (
        !defineGoal ||
        defineGoal.type !== 'function' ||
        !presentStep ||
        presentStep.type !== 'function'
      ) {
        throw new Error('Teaching tools missing');
      }
      const goal = z.object({ goal: z.object({ id: z.uuid() }) }).parse(
        await defineGoal.invoke(
          new RunContext(),
          JSON.stringify({
            purpose: 'walkthrough',
            outcome: 'Button clicked',
            criteria: ['Result is visible'],
          }),
        ),
      );
      read.mockImplementationOnce(() => {
        readStarted.resolve(true);
        return delayedObservation.promise;
      });
      const proposal = JSON.stringify({
        captureId: 'current-capture',
        goalRevisionId: goal.goal.id,
        checkpointId: null,
        previousStepAssessment: null,
        assessmentEvidence: 'Button is visible',
        instruction: 'Click the button.',
        expectedResult: 'Result appears',
        action: {
          kind: 'click',
          target: { label: 'Button', bounds: { x: 0.1, y: 0.2, width: 0.1, height: 0.05 } },
        },
        drawing: {
          strokes: [
            {
              points: [
                { x: 0.1, y: 0.2 },
                { x: 0.2, y: 0.2 },
              ],
              closed: false,
            },
          ],
        },
      });
      closedPresentationTool = (input) => presentStep.invoke(new RunContext(), input);
      pendingPresentation = presentStep.invoke(new RunContext(), proposal);
      await readStarted.promise;
      throw new Error('SDK segment ended while observation was pending');
    });
    const runner = new TeachingTaskRunner(server, companion, log, runAgent, observation);
    try {
      expect(
        await runner.run(
          'Click the button',
          DesktopLocale.ENGLISH,
          new AbortController().signal,
          receiveStep,
        ),
      ).toMatchObject({ outcome: 'failed' });
      const historyCount = history.mock.calls.length;
      const presenter: unknown = begin.mock.contexts.at(-1);
      if (
        !(presenter instanceof TeachingPresenter) ||
        !pendingPresentation ||
        !closedPresentationTool
      ) {
        throw new Error('Pending segment callback missing');
      }
      // A later segment must not revive the earlier SDK callback's permission.
      presenter.beginSegment();
      delayedObservation.resolve({ ...snapshot, input_revision: inputRevision });
      expect(await pendingPresentation).toEqual({
        admitted: false,
        reason: 'presentation_superseded',
      });
      expect(present).not.toHaveBeenCalled();
      expect(repairs).not.toHaveBeenCalled();
      expect(history.mock.calls).toHaveLength(historyCount);
      expect(receiveStep).not.toHaveBeenCalled();
      const readCount = read.mock.calls.length;
      await closedPresentationTool(
        JSON.stringify({
          captureId: 'current-capture',
          goalRevisionId: snapshot.watch_id,
          checkpointId: null,
          previousStepAssessment: null,
          assessmentEvidence: 'Button is visible',
          instruction: 'Click the button.',
          expectedResult: 'Result appears',
          action: { kind: 'keyboard', shortcut: 'Command+Space' },
          drawing: null,
        }),
      );
      expect(read).toHaveBeenCalledTimes(readCount);
      expect(repairs).not.toHaveBeenCalled();
    } finally {
      delayedObservation.resolve(snapshot);
      await companion.close();
    }
  },
);
