import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MCPServerStdio, type CallToolResult } from '@openai/agents';
import { EmbeddedDesktopDriver } from '../../../../../src/desktop/main/EmbeddedDesktopDriver.js';
import {
  DesktopObservationSchema,
  DesktopObservationTool,
} from '../../../../../src/contracts/DesktopObservation.js';
import {
  CursorCompanionTool,
  CursorCompanionCapabilitiesSchema,
  CursorGuidanceTaskSchema,
  CursorGuidanceResultSchema,
  CursorCompanionStateSchema,
  GuidanceCaptureRefreshSchema,
} from '../../../../../src/contracts/CursorCompanion.js';
import { describeCuaResult } from '../../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { z } from 'zod';
import {
  CompanionHudAckSchema,
  CompanionHudTool,
} from '../../../../../src/contracts/CompanionHud.js';

/** Bound each native boundary independently so a stalled call names its stage. */
async function callNativeTool(
  server: MCPServerStdio,
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  console.info(`Native probe request: ${toolName}`);
  const result = await server.callToolResult(toolName, args, null, {
    signal: AbortSignal.timeout(10000),
  });
  console.info(`Native probe response: ${toolName} ${JSON.stringify(describeCuaResult(result))}`);
  return result;
}

/** Exercise the production host and real native parsers with their injected
 * transport metadata. Captured pixels are discarded in memory, never exported
 * or forwarded to the scripted gateway. This does not inject physical input. */
export async function checkNativeTeachingBoundary(): Promise<void> {
  assert.equal(process.platform, 'darwin', 'The native teaching contract requires macOS.');
  const driver = new EmbeddedDesktopDriver();
  let server: MCPServerStdio | null = null;
  let peer: MCPServerStdio | null = null;
  const watchId = randomUUID();
  const taskEpoch = randomUUID();
  const group = randomUUID();
  try {
    const connection = await driver.start(() => {});
    server = new MCPServerStdio({ name: 'Native teaching contract', ...connection });
    peer = new MCPServerStdio({ name: 'Foreign native teaching connection', ...connection });
    await server.connect();
    await peer.connect();
    const tools = await server.listTools();
    for (const name of [
      ...Object.values(DesktopObservationTool),
      ...Object.values(CursorCompanionTool),
    ]) {
      assert.ok(
        tools.some((tool) => tool.name === name),
        `Native teaching tool missing: ${name}`,
      );
    }
    const message = {
      lessonId: watchId,
      stepId: taskEpoch,
      sequence: 1,
      kind: 'instruction',
      text: 'Nhập youtube.com rồi nhấn Enter.',
    };
    const presentation = await callNativeTool(peer, CompanionHudTool.SET_STATE, {
      group,
      sequence: 0,
      phase: 'waiting',
      locale: 'vi',
      level: 0,
      message,
    });
    assert.ok(!presentation.isError);
    assert.ok(CompanionHudAckSchema.parse(presentation.structuredContent).applied);
    const binding = await callNativeTool(server, CompanionHudTool.BIND_CURSOR, { group });
    assert.ok(CompanionHudAckSchema.parse(binding.structuredContent).applied);
    const capabilities = await callNativeTool(server, CursorCompanionTool.READ_CAPABILITIES, {});
    assert.ok(!capabilities.isError, 'Native capabilities must be admitted.');
    assert.equal(
      CursorCompanionCapabilitiesSchema.parse(capabilities.structuredContent).paired_presentation,
      true,
    );
    assert.ok(
      CursorCompanionCapabilitiesSchema.parse(
        capabilities.structuredContent,
      ).presentation_versions.includes(2),
    );
    const follow = await callNativeTool(server, CursorCompanionTool.SET_MODE, {
      mode: 'follow',
      label: 'Tro',
    });
    assert.ok(!follow.isError, 'Native follow presentation must start.');
    const task = await callNativeTool(server, CursorCompanionTool.BEGIN_TASK, {
      task_epoch: taskEpoch,
      presentation_version: 2,
    });
    assert.ok(!task.isError, 'Native preview epoch must be admitted.');
    assert.equal(CursorGuidanceTaskSchema.parse(task.structuredContent).status, 'task_ready');
    const renewal = await callNativeTool(server, CursorCompanionTool.SET_MODE, {
      mode: 'follow',
      label: 'Tro',
    });
    assert.ok(
      !renewal.isError,
      `Native following renewal during an active lesson failed: ${JSON.stringify(describeCuaResult(renewal))}`,
    );
    const renewed = CursorCompanionStateSchema.parse(renewal.structuredContent);
    assert.equal(renewed.following, true);
    assert.equal(renewed.guidance?.task_epoch, taskEpoch, 'Renewal must retain the preview epoch.');
    const state = await callNativeTool(server, CursorCompanionTool.READ_STATE, {});
    assert.ok(!state.isError, 'Native state with guidance metadata must pass output validation.');
    assert.equal(
      CursorCompanionStateSchema.parse(state.structuredContent).guidance?.task_epoch,
      taskEpoch,
    );
    const cueCapture = await callNativeTool(server, 'get_desktop_state', {
      max_image_dimension: 1200,
    });
    assert.ok(!cueCapture.isError, 'Native cue reference capture must succeed.');
    const cueMetadata = z
      .object({ capture_id: z.string().min(1) })
      .parse(cueCapture.structuredContent);
    const cueArgs = {
      capture_id: cueMetadata.capture_id,
      max_image_dimension: 1200,
      steps: [{ kind: 'click', at: { x: 0.5, y: 0.5 }, duration_ms: 300 }],
    };
    const refreshed = await callNativeTool(server, CursorCompanionTool.REFRESH_CAPTURE, cueArgs);
    assert.ok(
      !refreshed.isError,
      'Native cue comparison must pass risk, input and output contracts.',
    );
    const comparison = GuidanceCaptureRefreshSchema.parse(refreshed.structuredContent);
    assert.ok(
      comparison.diagnostics,
      'The rebuilt native driver must return comparison measurements.',
    );
    assert.equal(comparison.diagnostics.regions.length, 1);
    assert.equal(comparison.diagnostics.regions[0]?.step_kind, 'click');
    console.info(`PASS native comparison diagnostics: ${JSON.stringify(comparison.diagnostics)}`);
    assert.ok(
      !refreshed.content.some((part) => part.type === 'image'),
      'Local cue comparison must return no pixels.',
    );
    const foreignCapture = await callNativeTool(peer, CursorCompanionTool.REFRESH_CAPTURE, cueArgs);
    const foreignComparison = GuidanceCaptureRefreshSchema.parse(foreignCapture.structuredContent);
    assert.equal(foreignComparison.matched, false, 'Another connection cannot renew this capture.');
    assert.equal(foreignComparison.reason, 'capture_unavailable');
    console.info(
      `PASS native cue comparison: risk/input/output contracts, image-free result, capture isolation; live target ${comparison.reason}.`,
    );
    const begin = await callNativeTool(server, DesktopObservationTool.BEGIN, {
      watch_id: watchId,
      input_only: true,
    });
    assert.ok(
      !begin.isError,
      'Native watch admission failed: inspect risk classification and injected session metadata.',
    );
    const startedAt = performance.now();
    for (;;) {
      const result = await callNativeTool(server, DesktopObservationTool.READ, {
        watch_id: watchId,
      });
      assert.ok(!result.isError, 'Native watch metadata must be readable.');
      const state = DesktopObservationSchema.parse(result.structuredContent);
      assert.equal(state.watch_id, watchId);
      if (state.ready) {
        assert.equal(state.input_only, true);
        assert.equal(
          state.screen_revision,
          0,
          'Teaching must not start a continuous pixel stream.',
        );
        break;
      }
      assert.ok(
        performance.now() - startedAt < 10000,
        'Native first frame did not become ready within the teaching deadline.',
      );
      await delay(250);
    }
    const foreign = await callNativeTool(peer, DesktopObservationTool.READ, { watch_id: watchId });
    assert.equal(foreign.isError, true, 'Another connection must not read this lesson watch.');
    const capture = await callNativeTool(server, 'get_desktop_state', {});
    assert.ok(!capture.isError, 'Native capture must succeed.');
    const metadata = z
      .object({ capture_id: z.string().min(1), observation: DesktopObservationSchema })
      .safeParse(capture.structuredContent);
    assert.ok(metadata.success, 'Native capture must carry a valid watch snapshot.');
    assert.equal(metadata.data.observation.watch_id, watchId);
    assert.equal(
      capture.content.filter((part) => part.type === 'image').length,
      1,
      'A teaching observation needs exactly one image.',
    );
    const preview = await callNativeTool(server, CursorCompanionTool.SHOW_SEQUENCE, {
      capture_id: metadata.data.capture_id,
      presentation_version: 2,
      presentation_id: randomUUID(),
      text_only: false,
      hud_group: group,
      teaching_locale: 'vi',
      teaching_message: message,
      steps: [{ kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.03, duration_ms: 300 }],
    });
    const playback = CursorGuidanceResultSchema.parse(preview.structuredContent);
    if (playback.status === 'canceled' && playback.reason === 'user_takeover') {
      console.info(
        'NOT VERIFIED in this run: message/cue completion receipt; physical user input interrupted the disposable preview epoch.',
      );
    } else {
      assert.ok(
        !preview.isError,
        `Native message/cue admission failed: ${'reason' in playback ? playback.reason : playback.status}`,
      );
      assert.equal(playback.status, 'presented');
      assert.equal(playback.receipt.message_presented, true);
      assert.equal(playback.receipt.drawing_presented, true);
      assert.equal(playback.receipt.lesson_id, watchId);
      console.info(
        'PASS native message/cue: compositor accepted the message before V2 playback and returned a current receipt.',
      );
    }
    const endTask = await callNativeTool(server, CursorCompanionTool.END_TASK, {
      task_epoch: taskEpoch,
    });
    const interrupted = CursorGuidanceResultSchema.safeParse(endTask.structuredContent);
    const releasedAfterInput =
      endTask.isError === true &&
      interrupted.success &&
      interrupted.data.status === 'canceled' &&
      interrupted.data.reason === 'user_takeover' &&
      interrupted.data.task_epoch === taskEpoch;
    assert.ok(
      !endTask.isError || releasedAfterInput,
      'Native preview epoch must end or release after real user input.',
    );
    if (releasedAfterInput) {
      console.info(
        'Native probe observed real user input; the preview epoch was released with user_takeover.',
      );
    }
    const end = await callNativeTool(server, DesktopObservationTool.END, { watch_id: watchId });
    assert.ok(!end.isError, 'Native watch must end.');
    const after = await callNativeTool(server, DesktopObservationTool.READ, { watch_id: watchId });
    assert.equal(after.isError, true, 'An ended watch must be inaccessible.');
    const repeatedEnd = await callNativeTool(server, DesktopObservationTool.END, {
      watch_id: watchId,
    });
    assert.ok(!repeatedEnd.isError, 'Native teardown must be idempotent.');
    const inputWatch = await callNativeTool(server, DesktopObservationTool.BEGIN, {
      watch_id: watchId,
      input_only: true,
    });
    const inputState = DesktopObservationSchema.parse(inputWatch.structuredContent);
    assert.equal(inputState.input_only, true);
    assert.equal(inputState.ready, true);
    assert.equal(inputState.screen_revision, 0);
    await delay(800);
    const idleInput = await callNativeTool(server, DesktopObservationTool.READ, {
      watch_id: watchId,
    });
    assert.equal(DesktopObservationSchema.parse(idleInput.structuredContent).screen_revision, 0);
    const inputCapture = await callNativeTool(server, 'get_desktop_state', {});
    const inputCaptureMetadata = z
      .object({ observation: DesktopObservationSchema })
      .parse(inputCapture.structuredContent);
    assert.equal(inputCaptureMetadata.observation.input_only, true);
    assert.equal(inputCapture.content.filter((part) => part.type === 'image').length, 1);
    await callNativeTool(server, DesktopObservationTool.END, { watch_id: watchId });
    console.info(
      'PASS input-only native watch: ready without a comparison frame; on-demand capture remains available.',
    );
    console.info(
      `PASS native boundary: owned host, V2 epoch, watch admission, first frame (${String(Math.round(performance.now() - startedAt))}ms), capture snapshot, active-lesson renewal/state contracts, connection isolation, teardown.`,
    );
    console.info(
      'NOT VERIFIED: physical click/drag hooks, global Esc interception, visible cue rendering, and real-model decision quality. Use the documented manual acceptance flow.',
    );
  } finally {
    await server?.callToolResult(DesktopObservationTool.END, { watch_id: watchId }).catch(() => {});
    await server
      ?.callToolResult(CursorCompanionTool.END_TASK, { task_epoch: taskEpoch })
      .catch(() => {});
    await server?.callToolResult(CursorCompanionTool.SET_MODE, { mode: 'hidden' }).catch(() => {});
    await peer?.close().catch(() => {});
    await server?.close().catch(() => {});
    await driver.stop();
  }
}
