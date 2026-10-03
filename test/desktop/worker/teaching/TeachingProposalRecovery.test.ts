import { RunContext } from '@openai/agents';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { PresentTeachingStepSchema } from '#contracts/TeachingStep.js';
import {
  createTeachingAgent,
  type TeachingAgentControls,
} from '../../../../src/desktop/worker/agent/CreateComputerUseAgent.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { TeachingFailureCode } from '../../../../src/desktop/worker/teaching/TeachingFailure.js';

const proposal = {
  captureId: 'capture-current',
  goalRevisionId: '11111111-1111-4111-8111-111111111111',
  checkpointId: null,
  previousStepAssessment: null,
  assessmentEvidence: 'Live palette and workspace visible',
  instruction: 'Drag the block into the scripting workspace.',
  expectedResult: 'Block appears in workspace',
  action: {
    kind: 'click',
    target: { label: 'Block', bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.9 } },
  },
};

function createPresenter(
  controls: Pick<TeachingAgentControls, 'presentStep' | 'reportInvalidProposal'>,
) {
  const server = new LoggedCuaServer(
    { name: 'Tool input test', command: 'unused', args: [] },
    pino({ level: 'silent' }),
  );
  const agent = createTeachingAgent(server, DesktopLocale.ENGLISH, {
    defineGoal: () => ({}),
    reviseGoal: () => ({}),
    ...controls,
  });
  const presenter = agent.tools.find((entry) => entry.name === 'present_teaching_step');
  if (!presenter || presenter.type !== 'function') {
    throw new Error('Teaching presenter not found.');
  }
  return presenter;
}

it('returns field feedback for the captured oversized rectangle, then admits a corrected proposal', async () => {
  const presentStep = vi
    .fn<TeachingAgentControls['presentStep']>()
    .mockResolvedValue({ admitted: true });
  const reportInvalidProposal =
    vi.fn<NonNullable<TeachingAgentControls['reportInvalidProposal']>>();
  const presenter = createPresenter({ presentStep, reportInvalidProposal });
  const feedback: unknown = await presenter.invoke(new RunContext(), JSON.stringify(proposal));
  expect(feedback).toContain('invalid_tool_input');
  expect(feedback).toContain('action.target.bounds');
  expect(feedback).toContain('y + height <= 1');
  expect(presentStep).not.toHaveBeenCalled();
  const corrected = {
    ...proposal,
    action: {
      ...proposal.action,
      target: {
        ...proposal.action.target,
        bounds: { ...proposal.action.target.bounds, height: 0.5 },
      },
    },
  };
  const result: unknown = await presenter.invoke(new RunContext(), JSON.stringify(corrected));
  expect(result).toEqual({ admitted: true });
  expect(presentStep).toHaveBeenCalledWith(PresentTeachingStepSchema.parse(corrected));
  expect(reportInvalidProposal).toHaveBeenCalledWith(expect.objectContaining({ exhausted: false }));
});

it('bounds invalid JSON corrections and reports exhaustion without calling the presenter', async () => {
  const presentStep = vi.fn<TeachingAgentControls['presentStep']>();
  const reportInvalidProposal =
    vi.fn<NonNullable<TeachingAgentControls['reportInvalidProposal']>>();
  const presenter = createPresenter({ presentStep, reportInvalidProposal });
  await presenter.invoke(new RunContext(), '{broken');
  await presenter.invoke(new RunContext(), '{broken');
  await expect(presenter.invoke(new RunContext(), '{broken')).rejects.toMatchObject({
    name: 'InvalidToolInputError',
  });
  expect(reportInvalidProposal).toHaveBeenLastCalledWith(
    expect.objectContaining({ exhausted: true, attempt: 3 }),
  );
  expect(presentStep).not.toHaveBeenCalled();
});

it('rejects chat-only spatial arguments through the actual SDK tool before publishing anything', async () => {
  const presentStep = vi
    .fn<TeachingAgentControls['presentStep']>()
    .mockResolvedValue({ admitted: true });
  const presenter = createPresenter({ presentStep });
  const feedback: unknown = await presenter.invoke(
    new RunContext(),
    JSON.stringify({ ...proposal, action: { kind: 'click' } }),
  );
  expect(feedback).toContain('invalid_tool_input');
  expect(feedback).toContain('action.target');
  expect(presentStep).not.toHaveBeenCalled();
  await presenter.invoke(
    new RunContext(),
    JSON.stringify({
      ...proposal,
      action: {
        ...proposal.action,
        target: {
          ...proposal.action.target,
          bounds: { ...proposal.action.target.bounds, height: 0.5 },
        },
      },
    }),
  );
  expect(presentStep).toHaveBeenCalledOnce();
});

it('propagates native presentation failures instead of treating them as model input mistakes', async () => {
  const failure = new Error('Native presentation failed');
  const presentStep = vi.fn<TeachingAgentControls['presentStep']>().mockRejectedValue(failure);
  const presenter = createPresenter({ presentStep });
  await expect(
    presenter.invoke(
      new RunContext(),
      JSON.stringify({
        ...proposal,
        action: {
          ...proposal.action,
          target: {
            ...proposal.action.target,
            bounds: { ...proposal.action.target.bounds, height: 0.5 },
          },
        },
      }),
    ),
  ).rejects.toBe(failure);
});

it('reports a typed limit failure for repeatedly invalid rectangle bounds', async () => {
  const presentStep = vi.fn<TeachingAgentControls['presentStep']>();
  const presenter = createPresenter({ presentStep });
  await presenter.invoke(new RunContext(), JSON.stringify(proposal));
  await presenter.invoke(new RunContext(), JSON.stringify(proposal));
  await expect(presenter.invoke(new RunContext(), JSON.stringify(proposal))).rejects.toMatchObject({
    code: TeachingFailureCode.MODEL_INPUT_INVALID,
    reason: 'invalid_request',
  });
  expect(presentStep).not.toHaveBeenCalled();
});
