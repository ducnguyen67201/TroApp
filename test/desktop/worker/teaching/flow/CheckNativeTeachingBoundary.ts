import assert from 'node:assert/strict';
import { checkNativeHudRendering } from './CheckNativeHudRendering.js';
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
  GuidancePresentationRefusalSchema,
  GuidanceComparisonDiagnosticsSchema,
  GuidanceCoordinateTraceSchema,
  GuidanceTimingSchema,
} from '../../../../../src/contracts/CursorCompanion.js';
import { describeCuaResult } from '../../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { z } from 'zod';
import {
  CompanionHudAckSchema,
  CompanionHudTool,
} from '../../../../../src/contracts/CompanionHud.js';

let nativeProbeCallNumber = 0;
const nativeProbeStartedAt = performance.now();

/** Bound each native boundary independently so a stalled call names its stage. */
async function callNativeTool(
  server: MCPServerStdio,
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const callNumber = ++nativeProbeCallNumber;
  const startedAt = performance.now();
  console.info(
    `Native probe request: ${toolName} ${JSON.stringify({ callNumber, elapsedMs: Math.round(startedAt - nativeProbeStartedAt) })}`,
  );
  const result = await server.callToolResult(toolName, args, null, {
    signal: AbortSignal.timeout(10000),
  });
  console.info(
    `Native probe response: ${toolName} ${JSON.stringify({ callNumber, elapsedMs: Math.round(performance.now() - nativeProbeStartedAt), durationMs: Math.round(performance.now() - startedAt), ...describeCuaResult(result) })}`,
  );
  if (toolName === 'get_desktop_state') {
    const geometry = z
      .object({
        screen_width: z.number().int().positive(),
        screen_height: z.number().int().positive(),
        screenshot_width: z.number().int().positive(),
        screenshot_height: z.number().int().positive(),
        scale_factor: z.number().positive(),
      })
      .safeParse(result.structuredContent);
    if (geometry.success) {
      console.info(`Native probe capture geometry: ${JSON.stringify(geometry.data)}`);
    }
  }
  if (toolName === CursorCompanionTool.PRESENT_GUIDANCE) {
    const refusal = GuidancePresentationRefusalSchema.safeParse(result.structuredContent);
    if (refusal.success) {
      console.info(`Native probe freshness refusal: ${JSON.stringify(refusal.data)}`);
    } else {
      const timing = z
        .object({ timings_ms: GuidanceTimingSchema })
        .safeParse(result.structuredContent);
      if (timing.success) {
        console.info(`Native probe presentation timing: ${JSON.stringify(timing.data)}`);
      }
    }
  }
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
    await checkNativeHudRendering(peer);
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
      ).presentation_versions.includes(3),
    );
    const follow = await callNativeTool(server, CursorCompanionTool.SET_MODE, {
      mode: 'follow',
      label: 'Tro',
    });
    assert.ok(!follow.isError, 'Native follow presentation must start.');
    const task = await callNativeTool(server, CursorCompanionTool.BEGIN_TASK, {
      task_epoch: taskEpoch,
      presentation_version: 3,
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
    const drawing = {
      strokes: [
        {
          points: [
            { x: 0.45, y: 0.45 },
            { x: 0.55, y: 0.45 },
            { x: 0.55, y: 0.55 },
            { x: 0.45, y: 0.55 },
          ],
          closed: true,
        },
        {
          points: [
            { x: 0.4, y: 0.6 },
            { x: 0.6, y: 0.6 },
          ],
          closed: false,
        },
        {
          points: [
            { x: 0.4, y: 0.65 },
            { x: 0.5, y: 0.68 },
            { x: 0.6, y: 0.65 },
          ],
          closed: false,
        },
      ],
    };
    const request = {
      capture_id: metadata.data.capture_id,
      presentation_version: 3,
      presentation_id: randomUUID(),
      text_only: false,
      hud_group: group,
      teaching_locale: 'vi',
      teaching_message: message,
      targets: [{ x: 0.45, y: 0.45, width: 0.1, height: 0.1 }],
      drawing,
    };
    const preview = await callNativeTool(server, CursorCompanionTool.PRESENT_GUIDANCE, request);
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
      const coordinates = GuidanceCoordinateTraceSchema.parse(playback.coordinate_trace);
      assert.equal(coordinates.requested_capture_id, metadata.data.capture_id);
      assert.notEqual(
        coordinates.capture_id,
        coordinates.requested_capture_id,
        'Drawing uses a refreshed capture.',
      );
      assert.equal(playback.receipt.strokes_presented.length, 3);
      for (const [strokeIndex, stroke] of playback.receipt.strokes_presented.entries()) {
        assert.equal(stroke.stroke_index, strokeIndex);
        assert.equal(stroke.trace_progress, 1);
        assert.ok(stroke.hold_ms_observed >= 1100);
      }
      const comparison = GuidanceComparisonDiagnosticsSchema.parse(playback.comparison_diagnostics);
      assert.equal(comparison.matched, true);
      assert.equal(comparison.regions.length, 4);
      assert.equal(comparison.regions[0]?.region_kind, 'target');
      assert.ok(comparison.regions.slice(1).every((region) => region.region_kind === 'stroke'));
      assert.equal(coordinates.planned_strokes.length, 3);
      assert.equal(coordinates.painted_strokes.length, 3);
      for (const [strokeIndex, planned] of coordinates.planned_strokes.entries()) {
        const painted = coordinates.painted_strokes.find(
          (stroke) => stroke.stroke_index === strokeIndex,
        );
        assert.equal(planned.stroke_index, strokeIndex);
        assert.ok(painted, 'Native playback must report painter geometry.');
        assert.equal(
          painted.trace_progress,
          1,
          'Completed playback must include the complete cue.',
        );
        for (const [index, coordinate] of planned.cue_bounds_points.entries()) {
          const origin = painted.geometry.origin_points[index % 2];
          const actual = painted.geometry.cue_bounds_px[index];
          assert.ok(origin !== undefined && actual !== undefined);
          const expected = (coordinate - origin) * painted.geometry.backing_scale;
          assert.ok(
            Math.abs(actual - expected) < 0.1,
            'Painter bounds must match the converted native plan.',
          );
        }
      }
      console.info(`PASS native coordinate trace: ${JSON.stringify(coordinates)}`);
      console.info(
        'PASS native message/cue: compositor accepted the message before V3 scribble playback and returned a current receipt.',
      );
    }

    if (playback.status === 'presented') {
      /* All native requests below retain the same epoch; freshness refusals must not end it. */
      const unavailable = await callNativeTool(server, CursorCompanionTool.PRESENT_GUIDANCE, {
        ...request,
        presentation_id: randomUUID(),
        capture_id: randomUUID(),
      });
      assert.equal(unavailable.isError, true);
      assert.equal(
        GuidancePresentationRefusalSchema.parse(unavailable.structuredContent).reason,
        'capture_unavailable',
      );
      assert.ok(!unavailable.content.some((part) => part.type === 'image'));
      console.info('PASS V3 freshness: unavailable capture refuses without returning pixels.');
    }

    if (playback.status === 'presented') {
      const interruptCapture = await callNativeTool(server, 'get_desktop_state', {
        max_image_dimension: 1200,
      });
      const interruptMetadata = z
        .object({ capture_id: z.string().min(1) })
        .parse(interruptCapture.structuredContent);
      const interruptPromise = callNativeTool(server, CursorCompanionTool.PRESENT_GUIDANCE, {
        ...request,
        capture_id: interruptMetadata.capture_id,
        presentation_id: randomUUID(),
        max_image_dimension: 1200,
      });
      await delay(350);
      await callNativeTool(server, CursorCompanionTool.CANCEL_SEQUENCE, {});
      const interruptedDrawing = await interruptPromise;
      const interruptedResult = CursorGuidanceResultSchema.parse(
        interruptedDrawing.structuredContent,
      );
      assert.equal(interruptedDrawing.isError, true);
      assert.equal(interruptedResult.status, 'canceled');
      assert.ok(['explicit_stop', 'user_takeover'].includes(interruptedResult.reason));
      if (interruptedResult.reason === 'explicit_stop') {
        console.info(
          'PASS controlled V3 cancellation: explicit host stop never produces a success receipt.',
        );
      } else {
        console.info(
          'NOT VERIFIED: explicit host cancellation; real user input ended the disposable epoch first.',
        );
      }
    }
    const endTask = await callNativeTool(server, CursorCompanionTool.END_TASK, {
      task_epoch: taskEpoch,
    });
    const interrupted = CursorGuidanceResultSchema.safeParse(endTask.structuredContent);
    const releasedAfterInput =
      endTask.isError === true &&
      interrupted.success &&
      interrupted.data.status === 'canceled' &&
      ['user_takeover', 'explicit_stop'].includes(interrupted.data.reason) &&
      interrupted.data.task_epoch === taskEpoch;
    assert.ok(
      !endTask.isError || releasedAfterInput,
      'Native preview epoch must end or release after real user input.',
    );
    if (releasedAfterInput) {
      console.info('Native probe released the canceled preview epoch.');
    }

    /* Transfer the one native following lease before testing another connection. */
    await callNativeTool(server, CursorCompanionTool.SET_MODE, { mode: 'hidden' });
    const peerFollow = await callNativeTool(peer, CursorCompanionTool.SET_MODE, {
      mode: 'follow',
      label: 'Tro',
    });
    assert.ok(!peerFollow.isError);
    /* A separate native connection cannot use this connection's capture. */
    const foreignEpoch = randomUUID();
    const foreignTask = await callNativeTool(peer, CursorCompanionTool.BEGIN_TASK, {
      task_epoch: foreignEpoch,
      presentation_version: 3,
    });
    assert.ok(!foreignTask.isError);
    const foreignBinding = await callNativeTool(peer, CompanionHudTool.BIND_CURSOR, { group });
    assert.ok(!foreignBinding.isError);
    const foreignCapture = await callNativeTool(peer, CursorCompanionTool.PRESENT_GUIDANCE, {
      ...request,
      presentation_id: randomUUID(),
    });
    assert.equal(foreignCapture.isError, true);
    assert.equal(
      GuidancePresentationRefusalSchema.parse(foreignCapture.structuredContent).reason,
      'capture_unavailable',
    );
    await callNativeTool(peer, CursorCompanionTool.END_TASK, { task_epoch: foreignEpoch });

    await callNativeTool(peer, CursorCompanionTool.SET_MODE, { mode: 'hidden' });
    console.info(
      'PASS V3 capture isolation: another admitted native connection cannot present this connection’s capture.',
    );
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
      `PASS native boundary: owned host, V3 epoch, watch admission, first frame (${String(Math.round(performance.now() - startedAt))}ms), capture snapshot, active-lesson renewal/state contracts, connection isolation, teardown.`,
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
    await peer?.callToolResult(CursorCompanionTool.SET_MODE, { mode: 'hidden' }).catch(() => {});
    await peer?.close().catch(() => {});
    await server?.close().catch(() => {});
    await driver.stop();
  }
}
