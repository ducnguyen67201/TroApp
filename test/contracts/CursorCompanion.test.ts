import { describe, expect, it } from 'vitest';
import { CursorCompanionStateSchema } from '../../src/contracts/CursorCompanion.js';
import { AgentResultSchema } from '../../src/contracts/AgentSession.js';
import {
  CursorGuidanceResultSchema,
  TeachingResultSchema,
  CursorGuidancePresentationReceiptSchema,
  CursorCompanionCapabilitiesSchema,
  CursorGuidanceRequestHeaderSchema,
  hasValidPresentedStrokes,
  GuidanceTimingSchema,
} from '../../src/contracts/CursorCompanion.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const sequence = '22222222-2222-4222-8222-222222222222';

describe('guidance boundary contracts', () => {
  it('rejects explanation-only teaching results at the public boundary', () => {
    expect(
      AgentResultSchema.safeParse({
        kind: 'teaching',
        result: { outcome: 'explained', answer: 'Here is a written tutorial.' },
      }).success,
    ).toBe(false);
  });

  it('allows a specific student instruction without accepting an empty answer', () => {
    expect(
      AgentResultSchema.parse({
        kind: 'teaching',
        result: {
          outcome: 'needs_input',
          reason: 'no_demonstration',
          answer: 'Open ChatGPT first.',
        },
      }),
    ).toMatchObject({ result: { answer: 'Open ChatGPT first.' } });
    expect(
      TeachingResultSchema.safeParse({
        outcome: 'needs_input',
        reason: 'no_demonstration',
        answer: '  ',
      }).success,
    ).toBe(false);
  });

  it('rejects legacy drawing completion and old receipt versions', () => {
    expect(
      CursorCompanionStateSchema.safeParse({ status: 'completed', following: true, active: false })
        .success,
    ).toBe(false);
    expect(
      CursorGuidanceResultSchema.safeParse({ status: 'completed', following: true, active: false })
        .success,
    ).toBe(false);
    expect(
      CursorGuidanceResultSchema.safeParse({
        status: 'completed',
        following: true,
        active: false,
        receipt: {
          presentation_version: 2,
          task_epoch: epoch,
          sequence_id: sequence,
          completed_steps: 2,
        },
      }).success,
    ).toBe(false);
  });

  it('cannot attach a model completion answer to a canceled guide', () => {
    expect(
      TeachingResultSchema.safeParse({
        outcome: 'canceled',
        reason: 'user_takeover',
        answer: 'Done',
      }).success,
    ).toBe(false);
    expect(
      AgentResultSchema.parse({
        kind: 'teaching',
        result: { outcome: 'canceled', reason: 'user_takeover' },
      }),
    ).toEqual({ kind: 'teaching', result: { outcome: 'canceled', reason: 'user_takeover' } });
  });
});

it('validates only epoch-bound, content-free native input progression', () => {
  const state = {
    status: 'state',
    following: true,
    active: false,
    guidance: {
      task_epoch: '11111111-1111-4111-8111-111111111111',
      reason: 'user_takeover',
      input_revision: 2,
    },
  };
  expect(CursorCompanionStateSchema.safeParse(state).success).toBe(true);
  expect(
    CursorCompanionStateSchema.safeParse({
      ...state,
      guidance: { ...state.guidance, keys: 'private input' },
    }).success,
  ).toBe(false);
  expect(
    CursorCompanionStateSchema.safeParse({
      ...state,
      guidance: { ...state.guidance, task_epoch: 'old' },
    }).success,
  ).toBe(false);
});

const presentationReceipt = {
  presentation_version: 3,
  task_epoch: epoch,
  sequence_id: sequence,
  presentation_id: epoch,
  lesson_id: epoch,
  step_id: sequence,
  message_presented: true,
  drawing_presented: true,
  text_only: false,
  interrupted: false,
  strokes_presented: [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 }],
};

it('requires positive painted evidence, unique indices and completed reveal/hold', () => {
  expect(CursorGuidancePresentationReceiptSchema.safeParse(presentationReceipt).success).toBe(true);
  for (const strokes of [
    [],
    [{ stroke_index: 0, trace_progress: 0, hold_ms_observed: 1100 }],
    [{ stroke_index: 0, trace_progress: 0.5, hold_ms_observed: 1100 }],
    [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1099 }],
    [
      { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
      { stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 },
    ],
  ]) {
    expect(
      CursorGuidancePresentationReceiptSchema.safeParse({
        ...presentationReceipt,
        strokes_presented: strokes,
      }).success,
    ).toBe(false);
  }
  expect(
    CursorGuidancePresentationReceiptSchema.safeParse({
      ...presentationReceipt,
      presentation_version: 2,
    }).success,
  ).toBe(false);
});

it('checks all requested stroke indices while allowing truthful interrupted subsets', () => {
  const receipt = CursorGuidancePresentationReceiptSchema.parse(presentationReceipt);
  expect(hasValidPresentedStrokes(receipt, 1)).toBe(true);
  expect(hasValidPresentedStrokes(receipt, 2)).toBe(false);
  expect(hasValidPresentedStrokes(receipt, 0)).toBe(false);
  const interrupted = CursorGuidancePresentationReceiptSchema.parse({
    ...presentationReceipt,
    interrupted: true,
    strokes_presented: [{ stroke_index: 1, trace_progress: 0.25, hold_ms_observed: 0 }],
  });
  expect(hasValidPresentedStrokes(interrupted, 2)).toBe(true);
  expect(hasValidPresentedStrokes(interrupted, 1)).toBe(false);
  const textOnly = CursorGuidancePresentationReceiptSchema.parse({
    ...presentationReceipt,
    drawing_presented: false,
    text_only: true,
    strokes_presented: [],
  });
  expect(hasValidPresentedStrokes(textOnly, 0)).toBe(true);
  expect(hasValidPresentedStrokes(textOnly, 1)).toBe(false);
  expect(
    CursorGuidancePresentationReceiptSchema.safeParse({ ...textOnly, interrupted: true }).success,
  ).toBe(false);
  expect(hasValidPresentedStrokes({ ...textOnly, interrupted: true }, 0)).toBe(false);
});

it('requires the sole V3 scribble capability and explicit drawing agreement', () => {
  const capabilities = {
    presentation_versions: [3],
    task_lifecycle: true,
    paired_presentation: true,
    display_scope: 'primary',
    gestures: ['scribble'],
    max_strokes: 3,
    max_points_per_stroke: 32,
    max_duration_ms: 15000,
  };
  expect(CursorCompanionCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
  expect(
    CursorCompanionCapabilitiesSchema.safeParse({ ...capabilities, presentation_versions: [2, 3] })
      .success,
  ).toBe(false);
  expect(
    CursorCompanionCapabilitiesSchema.safeParse({
      ...capabilities,
      gestures: ['selection', 'scribble'],
    }).success,
  ).toBe(false);
  expect(
    CursorGuidanceRequestHeaderSchema.safeParse({
      presentation_version: 3,
      drawing: null,
      text_only: true,
    }).success,
  ).toBe(true);
  expect(
    CursorGuidanceRequestHeaderSchema.safeParse({
      presentation_version: 3,
      drawing: null,
      text_only: false,
    }).success,
  ).toBe(false);
  expect(
    CursorGuidanceRequestHeaderSchema.safeParse({
      presentation_version: 2,
      steps: [],
      text_only: true,
    }).success,
  ).toBe(false);
});

it('accepts bounded stage durations and excludes content from timing diagnostics', () => {
  const timings = {
    compile_ms: 2,
    refresh_ms: 20,
    comparison_ms: 3,
    first_frame_ms: 30,
    presentation_ms: 2600,
  };
  expect(GuidanceTimingSchema.safeParse(timings).success).toBe(true);
  expect(GuidanceTimingSchema.safeParse({ ...timings, compile_ms: -1 }).success).toBe(false);
  expect(GuidanceTimingSchema.safeParse({ ...timings, refresh_ms: 120001 }).success).toBe(false);
  expect(GuidanceTimingSchema.safeParse({ ...timings, screenshot: 'private' }).success).toBe(false);
});
