import { MCPServerStdio, mcpToFunctionTool, type CallToolResult } from '@openai/agents';
import pino from 'pino';
import { PassThrough } from 'node:stream';
import {
  AgentLogRole,
  withAgentLogContext,
} from '../../../../src/desktop/worker/agent/AgentDebugLog.js';
import { describe, expect, it, vi } from 'vitest';
import { TaskContext } from '../../../../src/desktop/worker/execution/TaskContext.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { enableAgentExchangeLog } from '../../../../src/desktop/worker/agent/AgentExchangeLog.js';

it('logs the comparison input and failing cue region without screenshots or pixel colors', async () => {
  const output = new PassThrough();
  const lines: string[] = [];
  output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
  const log = pino({ level: 'debug' }, output);
  enableAgentExchangeLog(log);
  const server = new LoggedCuaServer({ name: 'comparison fixture', command: 'unused' }, log);
  server.beginTeachingTask('11111111-1111-4111-8111-111111111111', () => {});
  const driver = vi
    .spyOn(MCPServerStdio.prototype, 'callToolResult')
    .mockImplementation(async (name) => {
      await Promise.resolve();
      if (name === 'get_desktop_state') {
        return {
          content: [{ type: 'image', data: 'cHJpdmF0ZS1zY3JlZW5zaG90', mimeType: 'image/png' }],
          structuredContent: {
            capture_id: 'original-capture',
            display: 'primary',
            screen_width: 1000,
            screen_height: 800,
            screenshot_width: 1000,
            screenshot_height: 800,
            scale_factor: 1,
          },
        };
      }
      if (name === 'refresh_cursor_guidance_capture') {
        return {
          content: [{ type: 'text', text: 'guidance_capture_comparison' }],
          structuredContent: {
            matched: false,
            capture_id: null,
            reason: 'target_changed',
            diagnostics: {
              matched: false,
              capture_width_px: 1000,
              capture_height_px: 800,
              regions: [
                {
                  step_index: 0,
                  step_kind: 'circle',
                  bounds_px: [400, 300, 600, 500],
                  compared_pixels: 40000,
                  changed_pixels: 2,
                  changed_fraction: 0.00005,
                  max_channel_delta: 20,
                  first_changed_pixel: [500, 400],
                },
              ],
            },
          },
        };
      }
      throw new Error('Drawing must not dispatch after a failed comparison.');
    });
  try {
    await server.callToolResult('get_desktop_state', {});
    const result = await server.showTeachingCue({
      capture_id: 'original-capture',
      presentation_version: 2,
      steps: [{ kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.04, duration_ms: 300 }],
    });
    expect(result.isError).toBe(true);
    const logs = lines.join('');
    expect(logs).toContain('teaching.capture_comparison');
    expect(logs).toContain('"cueSteps"');
    expect(logs).toContain('"comparisonDiagnosticsAvailable":true');
    expect(logs).toContain('"changed_pixels":2');
    expect(logs).toContain('"first_changed_pixel":[500,400]');
    expect(logs).toContain('"bounds_px":[400,300,600,500]');
    expect(logs).not.toContain('cHJpdmF0ZS1zY3JlZW5zaG90');
  } finally {
    driver.mockRestore();
    server.endTeachingTask();
  }
});

describe('Cua tool schemas presented to the Agents SDK', () => {
  it('correlates accepted calls and diagnoses admission refusals without logging private arguments', async () => {
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    const log = pino({ level: 'debug' }, output);
    const server = new LoggedCuaServer({ name: 'logging fixture', command: 'unused' }, log);
    const task = new TaskContext(server.taskEvidence, new AbortController().signal);
    server.bindTask(task);
    server.taskEvidence.setReadOnlyTools(['get_window_state']);
    const driver = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'private observed diagnostic' }],
      structuredContent: { status: 'refused', error: { code: 'window_id_not_found' } },
    });
    try {
      await withAgentLogContext(
        { taskId: task.id, agentRole: AgentLogRole.MAIN, attemptNumber: 1 },
        async () => {
          await server.callToolResult('type_text', { text: 'private password' });
          expect(driver).not.toHaveBeenCalled();
          await server.callToolResult('get_window_state', {
            pid: 7,
            window_id: 12,
            display_id: 2,
            delivery_mode: 'background',
            include_screenshot: true,
            text: 'private password',
          });
        },
      );
      const logs = lines.join('');
      expect(logs).toContain('cua.admission.rejected');
      expect(logs).toContain('goal_acknowledgement_required');
      expect(logs).toContain('"reasonCode":"window_id_not_found"');
      expect(logs).toContain('"deliveryMode":"background"');
      expect(logs).toContain('"windowId":12');
      expect(logs.match(/"dispatchId":"dispatch-2"/g)).toHaveLength(2);
      expect(logs.match(/"callId":"call-1"/g)).toHaveLength(2);
      expect(logs).toContain('"taskId":"' + task.id + '"');
      expect(logs).not.toContain('private');
    } finally {
      task.dispose();
      driver.mockRestore();
    }
  });
  it('uses Cua read-only annotations to identify calls needing a later observation', async () => {
    const tools = [
      {
        name: 'launch_app',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      {
        name: 'get_window_state',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
    ];
    const listTools = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(tools);
    const server = new LoggedCuaServer(
      { name: 'Cua annotations test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );

    try {
      await server.listTools();
      const accepted: CallToolResult = { content: [], structuredContent: {} };
      const write = server.taskEvidence.beginToolCall('launch_app');
      server.taskEvidence.recordToolResult(write, null, accepted);
      expect(server.taskEvidence.readSnapshot().revision).toBe(1);
      const read = server.taskEvidence.beginToolCall('get_window_state');
      server.taskEvidence.recordToolResult(read, null, accepted);
      expect(server.taskEvidence.readSnapshot().revision).toBe(1);
    } finally {
      listTools.mockRestore();
    }
  });

  it('keeps open arguments non-strict without triggering strict conversion warnings', async () => {
    const cuaTool = {
      name: 'browser_click',
      description: 'Click a bound page element.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          target_id: { type: 'string' },
          tab_id: { type: 'string' },
        },
        required: ['target_id', 'tab_id'],
        additionalProperties: true,
      },
    };
    const listTools = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([cuaTool]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = new LoggedCuaServer(
      { name: 'Cua schema test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );

    try {
      const [preparedTool] = await server.listTools();
      expect(preparedTool).toBeDefined();
      if (!preparedTool) {
        return;
      }
      const agentTool = mcpToFunctionTool(preparedTool, server, false);

      expect(cuaTool.inputSchema.additionalProperties).toBe(true);
      expect(preparedTool.inputSchema.additionalProperties).toBe(false);
      expect(agentTool.strict).toBe(false);
      expect(agentTool.parameters).toEqual(cuaTool.inputSchema);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      listTools.mockRestore();
      warning.mockRestore();
    }
  });

  it('records a failed Cua action even when debug logging is disabled', async () => {
    const failedResult: CallToolResult = {
      content: [{ type: 'text', text: 'Could not activate window.' }],
      structuredContent: { code: 'bring_to_front_window_not_found' },
      isError: true,
    };
    const callTool = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockResolvedValue(failedResult);
    const server = new LoggedCuaServer(
      { name: 'Cua result test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );

    try {
      await server.callToolResult('bring_to_front', { pid: 7, window_id: 12 });
      expect(server.taskEvidence.readSnapshot().failureCount).toBe(1);
    } finally {
      callTool.mockRestore();
    }
  });
  it('blocks a write before goal acknowledgement and preserves observation images', async () => {
    const driver = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue({
      content: [{ type: 'image', data: 'synthetic', mimeType: 'image/png' }],
      structuredContent: { pid: 7, window_id: 12 },
    });
    const server = new LoggedCuaServer(
      { name: 'goal gate test', command: 'unused', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const task = new TaskContext(server.taskEvidence, new AbortController().signal);
    server.bindTask(task);
    try {
      const blocked = await server.callToolResult('launch_app', {});
      expect(blocked.isError).toBe(true);
      expect(driver).not.toHaveBeenCalled();
      task.defineGoal({
        summary: 'Show app',
        criteria: [
          {
            description: 'Show app content',
          },
        ],
      });
      task.admitModelTurn();
      server.taskEvidence.setReadOnlyTools(['get_window_state']);
      const observed = await server.callToolResult('get_window_state', { pid: 7, window_id: 12 });
      expect(observed.content[0]).toEqual({
        type: 'image',
        data: 'synthetic',
        mimeType: 'image/png',
      });
      const reference = observed.content.at(-1);
      expect(reference?.type).toBe('text');
      if (reference?.type === 'text' && typeof reference.text === 'string') {
        expect(reference.text).toContain('evidence-call-1-1');
      }
      expect(server.taskEvidence.readSnapshot().observations).toHaveLength(1);
    } finally {
      task.dispose();
      driver.mockRestore();
    }
  });

  it('serializes desktop calls and prevents queued work after cancellation', async () => {
    let release: ((value: CallToolResult) => void) | undefined;
    const driver = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockImplementation(
      () =>
        new Promise<CallToolResult>((resolve) => {
          release = resolve;
        }),
    );
    const server = new LoggedCuaServer(
      { name: 'queue test', command: 'unused', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const user = new AbortController();
    const task = new TaskContext(server.taskEvidence, user.signal);
    server.bindTask(task);
    server.taskEvidence.setReadOnlyTools(['get_window_state']);
    try {
      const first = server.callToolResult('get_window_state', { pid: 7, window_id: 12 });
      const second = server.callToolResult('get_window_state', { pid: 7, window_id: 12 });
      const rejected = expect(second).rejects.toThrow();
      await Promise.resolve();
      expect(driver).toHaveBeenCalledTimes(1);
      user.abort();
      release?.({ content: [] });
      await first;
      await rejected;
      await server.settleCalls();
      expect(driver).toHaveBeenCalledTimes(1);
      expect(server.taskEvidence.readSnapshot().inFlight).toBe(0);
    } finally {
      task.dispose();
      driver.mockRestore();
    }
  });
});
