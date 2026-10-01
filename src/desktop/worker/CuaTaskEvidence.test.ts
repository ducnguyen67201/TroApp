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
});
