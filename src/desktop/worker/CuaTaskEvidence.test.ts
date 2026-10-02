import type { CallToolResult } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { CuaTaskEvidence } from './CuaTaskEvidence.js';
import { TeachingReplyKind } from './TeachingReply.js';
import { GuidanceReason } from '#contracts/CursorCompanion.js';

const state: CallToolResult = {
  content: [{ type: 'text', text: 'Synthetic page text' }],
  structuredContent: { pid: 7, window_id: 12 },
};

describe('task-local evidence collection', () => {
  it('keeps diagnostic failures separate from fresh observations', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setReadOnlyTools(['get_window_state']);
    evidence.recordToolResult(evidence.beginToolCall('bring_to_front'), null, {
      isError: true,
      content: [],
    });
    const recorded = evidence.recordToolResult(
      evidence.beginToolCall('get_window_state'),
      { pid: 7, window_id: 12 },
      state,
    );
    expect(recorded.observations).toHaveLength(1);
    expect(evidence.readSnapshot()).toMatchObject({
      failureCount: 1,
      mutationCount: 1,
      revision: 1,
      inFlight: 0,
    });
  });

  it('invalidates old observations even when a later write fails', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setReadOnlyTools(['get_window_state']);
    evidence.recordToolResult(evidence.beginToolCall('get_window_state'), null, state);
    const pendingRead = evidence.beginToolCall('get_window_state');
    evidence.recordToolResult(evidence.beginToolCall('hotkey'), null, {
      isError: true,
      content: [],
    });
    expect(evidence.recordToolResult(pendingRead, null, state).observations).toEqual([]);
    const snapshot = evidence.readSnapshot();
    expect(snapshot.observations.filter((item) => item.revision === snapshot.revision)).toEqual([]);
  });

  it('does not mint evidence for failed tools, config reads or mismatched targets', () => {
    const evidence = new CuaTaskEvidence();
    for (const [name, args, result] of [
      ['get_config', null, state],
      ['get_window_state', null, { ...state, isError: true }],
      ['get_window_state', { pid: 9, window_id: 12 }, state],
      [
        'get_window_state',
        { pid: 7, window_id: 12, display_id: 2 },
        { ...state, structuredContent: { pid: 7, window_id: 12, display_id: 1 } },
      ],
      [
        'get_window_state',
        null,
        { ...state, structuredContent: { pid: 7, window_id: 12, is_visible: 'yes' } },
      ],
    ] satisfies [string, Record<string, unknown> | null, CallToolResult][]) {
      expect(
        evidence.recordToolResult(evidence.beginToolCall(name), args, result).observations,
      ).toEqual([]);
    }
  });

  it('records refusal as diagnostic failure without treating it as observation proof', () => {
    const evidence = new CuaTaskEvidence();
    expect(
      evidence.recordToolResult(evidence.beginToolCall('browser_prepare'), null, {
        content: [],
        structuredContent: { status: 'refused' },
      }).observations,
    ).toEqual([]);
    expect(evidence.readSnapshot().failureCount).toBe(1);
  });

  it('adapts pinned driver window visibility without saving window titles', () => {
    const evidence = new CuaTaskEvidence();
    evidence.setReadOnlyTools(['list_windows']);
    const recorded = evidence.recordToolResult(evidence.beginToolCall('list_windows'), null, {
      content: [],
      structuredContent: {
        current_space_id: null,
        windows: [
          {
            pid: 7,
            window_id: 12,
            is_on_screen: true,
            on_current_space: null,
            title: 'Private title',
            bounds: { x: 2000 },
          },
          { pid: 7, window_id: 13, is_on_screen: false, on_current_space: false },
        ],
      },
    });
    expect(recorded.observations.map((item) => item.fields.is_visible)).toEqual([true, false]);
    expect(JSON.stringify(evidence.readSnapshot())).not.toContain('Private title');
    evidence.reset();
    expect(evidence.readSnapshot()).toMatchObject({
      revision: 0,
      mutationCount: 0,
      failureCount: 0,
      observations: [],
      inFlight: 0,
    });
  });
});

function result(structuredContent: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [], structuredContent, isError };
}

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
  it('requires a nonempty explicit explanation before exposing prose without a guide', () => {
    const evidence = new CuaTaskEvidence();
    evidence.beginGuidanceTask(taskEpoch);
    expect(
      evidence.readTeachingResult('Start with a question', TeachingReplyKind.EXPLANATION),
    ).toEqual({
      outcome: 'explained',
      answer: 'Start with a question',
    });
    expect(evidence.readTeachingResult('  ', TeachingReplyKind.EXPLANATION)).toEqual({
      outcome: 'needs_input',
      reason: 'no_demonstration',
    });
  });

  it('never replaces a pending, failed or canceled guide with an explanation', () => {
    const evidence = new CuaTaskEvidence();
    evidence.beginGuidanceTask(taskEpoch);
    evidence.beginGuidanceRequest(2);
    expect(evidence.readTeachingResult('Try this', TeachingReplyKind.EXPLANATION)).toEqual({
      outcome: 'failed',
      reason: 'transport_failed',
    });
    evidence.failGuidance(GuidanceReason.INVALID_REQUEST);
    expect(evidence.readTeachingResult('Try this', TeachingReplyKind.EXPLANATION)).toEqual({
      outcome: 'failed',
      reason: 'invalid_request',
    });
    evidence.cancelGuidance(GuidanceReason.USER_TAKEOVER);
    expect(evidence.readTeachingResult('Try this', TeachingReplyKind.EXPLANATION)).toEqual({
      outcome: 'canceled',
      reason: 'user_takeover',
    });
  });

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
