import { MCPServerStdio, type CallToolResult } from '@openai/agents';
import pino, { type Logger } from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { CursorCompanionTool } from '#contracts/CursorCompanion.js';
import { ComputerUseTaskRunner } from '../../../../src/desktop/worker/agent/ComputerUseTaskRunner.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { runComputerUseAgent } from '../../../../src/desktop/worker/agent/RunComputerUseAgent.js';
import { DesktopObservationTool } from '#contracts/DesktopObservation.js';

async function createRunner(log: Logger = pino({ level: 'silent' })) {
  let epoch = '';
  let watchId = '';
  const scene = { screenRevision: 1, inputRevision: 0, ready: true, targetChanged: false };
  const observation = () => ({
    watch_id: watchId,
    screen_revision: scene.screenRevision,
    input_revision: scene.inputRevision,
    ready: scene.ready,
    changed_fraction: 0.2,
    quiet_ms: 1000,
    buttons_down: false,
    screen_width: 1000,
    screen_height: 800,
  });
  vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(
    [...Object.values(CursorCompanionTool), ...Object.values(DesktopObservationTool)].map(
      (name) => ({
        name,
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      }),
    ),
  );
  const native = vi
    .spyOn(MCPServerStdio.prototype, 'callToolResult')
    .mockImplementation(async (name, args): Promise<CallToolResult> => {
      await Promise.resolve();
      if (name === DesktopObservationTool.BEGIN) {
        watchId = typeof args?.watch_id === 'string' ? args.watch_id : '';
      }
      if (Object.values(DesktopObservationTool).some((tool) => tool === name)) {
        return { content: [], structuredContent: observation() };
      }
      if (name === 'get_desktop_state') {
        return {
          content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
          structuredContent: {
            capture_id: 'fresh',
            display: 'primary',
            screen_width: 1000,
            screen_height: 800,
            screenshot_width: 1000,
            screenshot_height: 800,
            scale_factor: 1,
            observation: observation(),
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
      if (name === CursorCompanionTool.BEGIN_TASK) {
        const supplied: unknown = args?.task_epoch;
        if (typeof supplied !== 'string') {
          throw new Error('Missing epoch');
        }
        epoch = supplied;
        return {
          content: [],
          structuredContent: {
            status: 'task_ready',
            task_epoch: epoch,
            following: true,
            active: false,
          },
        };
      }
      if (name === CursorCompanionTool.END_TASK) {
        return {
          content: [],
          structuredContent: {
            status: 'task_ended',
            task_epoch: epoch,
            following: true,
            active: false,
          },
        };
      }
      if (name === CursorCompanionTool.SET_MODE && args?.mode === 'hidden') {
        return {
          content: [],
          structuredContent: { status: 'hidden', following: false, active: false },
        };
      }
      return {
        content: [],
        structuredContent: { status: 'following', following: true, active: false },
      };
    });
  const server = new LoggedCuaServer({ name: 'Test', command: 'unused' }, log);
  await server.listTools();
  const runAgent = vi.fn<typeof runComputerUseAgent>();
  const runner = new ComputerUseTaskRunner(server, log, runAgent);
  return { server, runner, runAgent, native, scene, readEpoch: () => epoch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('starts companion following on the main-owned endpoint without a model run', async () => {
  vi.useFakeTimers();
  vi.spyOn(MCPServerStdio.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(MCPServerStdio.prototype, 'close').mockResolvedValue(undefined);
  const { native } = await createRunner();
  const runner = await ComputerUseTaskRunner.connect(
    pino({ level: 'silent' }),
    {
      command: '/tro/cua-driver',
      args: ['mcp', '--embedded', '--socket', '/private/tro.sock'],
      env: { CUA_DRIVER_EMBEDDED: '1' },
    },
    true,
  );
  expect(native).toHaveBeenCalledWith(CursorCompanionTool.SET_MODE, {
    mode: 'follow',
    label: 'Tro',
  });
  await runner.close();
  expect(native).toHaveBeenCalledWith(CursorCompanionTool.SET_MODE, { mode: 'hidden' });
});

it('closes the host transport when required companion tools are absent', async () => {
  vi.spyOn(MCPServerStdio.prototype, 'connect').mockResolvedValue(undefined);
  const close = vi.spyOn(MCPServerStdio.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([
    {
      name: 'get_desktop_state',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ]);
  await expect(
    ComputerUseTaskRunner.connect(
      pino({ level: 'silent' }),
      {
        command: '/tro/cua-driver',
        args: ['mcp', '--embedded'],
        env: {},
      },
      true,
    ),
  ).rejects.toThrow('companion tools');
  expect(close).toHaveBeenCalledOnce();
});
