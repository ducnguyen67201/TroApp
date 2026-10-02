import type { CallToolResult } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { CuaTaskEvidence, TaskIssue } from './CuaTaskEvidence.js';

function result(structuredContent: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: '' }], structuredContent, isError };
}

describe('Cua task completion evidence', () => {
  it('requires a fresh Cua state observation after an accepted desktop action', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setToolsRequiringObservation(['launch_app', 'browser_navigate']);

    evidence.record('launch_app', result({ launch_state: { window_ready: true } }));
    expect(evidence.readIssue()).toBe(TaskIssue.OBSERVATION_MISSING);

    evidence.record('list_windows', result({ windows: [] }));
    expect(evidence.readIssue()).toBe(TaskIssue.OBSERVATION_MISSING);

    evidence.record('get_window_state', result({ elements: [] }));
    expect(evidence.readIssue()).toBeNull();

    evidence.record('browser_navigate', result({ status: 'completed' }));
    expect(evidence.readIssue()).toBe(TaskIssue.OBSERVATION_MISSING);

    evidence.record('get_browser_state', result({ tabs: [] }));
    expect(evidence.readIssue()).toBeNull();
  });

  it('keeps a failed action incomplete until Cua verifies the requested result', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setToolsRequiringObservation(['launch_app']);
    evidence.record('launch_app', result({ code: 'window_not_found' }, true));
    expect(evidence.readIssue()).toBe(TaskIssue.DESKTOP_ACTION_FAILED);

    evidence.record('list_windows', result({ windows: [] }));
    expect(evidence.readIssue()).toBe(TaskIssue.DESKTOP_ACTION_FAILED);

    evidence.record('verify_state', result({ status: 'satisfied' }));
    expect(evidence.readIssue()).toBeNull();
  });

  it('accepts an observed successful path after an earlier Cua tool fails', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setToolsRequiringObservation(['browser_prepare', 'launch_app', 'hotkey']);

    evidence.record('browser_prepare', result({ status: 'refused' }));
    expect(evidence.readIssue()).toBe(TaskIssue.DESKTOP_ACTION_FAILED);

    evidence.record('launch_app', result({ launch_state: { window_ready: true } }));
    evidence.record('list_windows', result({ windows: [] }));
    expect(evidence.readIssue()).toBe(TaskIssue.DESKTOP_ACTION_FAILED);

    evidence.record('get_window_state', result({ elements: [] }));
    expect(evidence.readIssue()).toBeNull();

    evidence.record('hotkey', result({}));
    expect(evidence.readIssue()).toBe(TaskIssue.OBSERVATION_MISSING);
  });

  it('treats unsatisfied and unknown verification as incomplete without an MCP error', () => {
    const evidence = new CuaTaskEvidence();
    evidence.record('verify_state', result({ status: 'unsatisfied' }));
    expect(evidence.readIssue()).toBe(TaskIssue.VERIFICATION_FAILED);

    evidence.record('verify_state', result({ status: 'unknown' }));
    expect(evidence.readIssue()).toBe(TaskIssue.VERIFICATION_FAILED);

    evidence.record('verify_state', result({ status: 'satisfied' }));
    expect(evidence.readIssue()).toBeNull();
  });

  it('treats a refused action as failed and clears task state on reset', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setToolsRequiringObservation(['browser_navigate']);
    evidence.record('browser_navigate', result({ status: 'refused' }));
    expect(evidence.readIssue()).toBe(TaskIssue.DESKTOP_ACTION_FAILED);

    evidence.reset();
    expect(evidence.readIssue()).toBeNull();
  });
  it('never treats cursor previews or metadata as desktop-action verification', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setToolsRequiringObservation(['bring_to_front', 'show_cursor_sequence']);
    evidence.record('bring_to_front', result({}));
    for (const name of [
      'show_cursor_sequence',
      'get_agent_cursor_state',
      'get_cursor_companion_state',
      'get_config',
      'get_cursor_position',
    ]) {
      evidence.record(name, result({ status: 'completed', following: true, active: false }));
      expect(evidence.readIssue()).toBe(TaskIssue.OBSERVATION_MISSING);
    }
    evidence.record('get_desktop_state', result({}));
    expect(evidence.readIssue()).toBeNull();
    evidence.record(
      'show_cursor_sequence',
      result({ status: 'completed', following: true, active: false }),
    );
    expect(evidence.readIssue()).toBeNull();
  });
});

const taskEpoch = '11111111-1111-4111-8111-111111111111';
const sequenceId = '22222222-2222-4222-8222-222222222222';
const completedGuide = {
  status: 'completed',
  following: true,
  active: false,
  receipt: {
    presentation_version: 2,
    task_epoch: taskEpoch,
    sequence_id: sequenceId,
    completed_steps: 2,
  },
};

describe('positive V2 teaching evidence', () => {
  it('does not call a guide demonstrated when only prose or desktop verification succeeds', () => {
    const evidence = new CuaTaskEvidence();
    evidence.beginGuidanceTask(taskEpoch);
    evidence.record('verify_state', result({ status: 'satisfied' }));
    expect(evidence.readTeachingResult('I showed you')).toEqual({
      outcome: 'needs_input',
      reason: 'no_demonstration',
    });
  });

  it('accepts matching receipts once, independent of action verification', () => {
    const evidence = new CuaTaskEvidence();
    evidence.beginGuidanceTask(taskEpoch);
    const request = evidence.beginGuidanceRequest(2);
    if (!request) {
      throw new Error('Missing live guidance request');
    }
    expect(evidence.settleGuidanceRequest(request, result(completedGuide))).toBe(true);
    expect(evidence.readTeachingResult('Next step')).toEqual({
      outcome: 'demonstrated',
      answer: 'Next step',
    });
    expect(evidence.settleGuidanceRequest(request, result(completedGuide))).toBe(false);
  });

  it.each(['wrong epoch', 'wrong step count', 'legacy receipt'])('rejects %s evidence', (kind) => {
    const evidence = new CuaTaskEvidence();
    evidence.beginGuidanceTask(taskEpoch);
    const request = evidence.beginGuidanceRequest(2);
    if (!request) {
      throw new Error('Missing live guidance request');
    }
    const receipt = {
      ...completedGuide.receipt,
      ...(kind === 'wrong epoch' ? { task_epoch: sequenceId } : { completed_steps: 1 }),
    };
    expect(
      evidence.settleGuidanceRequest(
        request,
        result(
          kind === 'legacy receipt'
            ? { status: 'completed', following: true, active: false }
            : { ...completedGuide, receipt },
        ),
      ),
    ).toBe(false);
    evidence.record('verify_state', result({ status: 'satisfied' }));
    expect(evidence.readTeachingResult('Done')).toEqual({
      outcome: 'failed',
      reason: 'transport_failed',
    });
  });

  it('keeps takeover terminal after later observations and rejects replay', () => {
    const evidence = new CuaTaskEvidence();
    evidence.beginGuidanceTask(taskEpoch);
    const request = evidence.beginGuidanceRequest(2);
    if (!request) {
      throw new Error('Missing live guidance request');
    }
    evidence.settleGuidanceRequest(
      request,
      result(
        {
          status: 'canceled',
          following: true,
          active: false,
          task_epoch: taskEpoch,
          sequence_id: sequenceId,
          reason: 'user_takeover',
        },
        true,
      ),
    );
    evidence.record('get_desktop_state', result({}));
    evidence.record('verify_state', result({ status: 'satisfied' }));
    expect(evidence.beginGuidanceRequest(2)).toBeNull();
    expect(evidence.readTeachingResult('Done')).toEqual({
      outcome: 'canceled',
      reason: 'user_takeover',
    });
    evidence.beginGuidanceTask(sequenceId);
    expect(evidence.beginGuidanceRequest(1)).not.toBeNull();
    expect(evidence.settleGuidanceRequest(request, result(completedGuide))).toBe(false);
  });
});
