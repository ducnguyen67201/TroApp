import { describe, expect, it } from 'vitest';
import type { DesktopObservation } from '#contracts/DesktopObservation.js';
import { TeachingObservationPolicy } from '../../../../src/desktop/worker/observation/TeachingObservationPolicy.js';

const baseline: DesktopObservation = {
  watch_id: '11111111-1111-4111-8111-111111111111',
  screen_revision: 1,
  input_revision: 1,
  ready: true,
  changed_fraction: 0,
  quiet_ms: 1000,
  buttons_down: false,
  screen_width: 1200,
  screen_height: 800,
};

describe('lesson scheduling', () => {
  it('requires settled input, permits tiny user edits, and ignores unchanged screens', () => {
    const policy = new TeachingObservationPolicy();
    expect(policy.canObserve(baseline, baseline)).toBe(false);
    expect(policy.canObserve(baseline, { ...baseline, input_revision: 2, quiet_ms: 100 })).toBe(
      false,
    );
    expect(
      policy.canObserve(baseline, { ...baseline, input_revision: 2, buttons_down: true }),
    ).toBe(false);
    expect(policy.canObserve(baseline, { ...baseline, input_revision: 2 })).toBe(true);
    expect(policy.canObserve(baseline, { ...baseline, screen_revision: 2, ready: false })).toBe(
      false,
    );
  });

  it('ignores passive visual changes while preserving explicit interaction', () => {
    let time = 0;
    const policy = new TeachingObservationPolicy(() => time);
    policy.admitRun();
    policy.recordAssessment(false);
    const changed = { ...baseline, screen_revision: 2 };
    time = 4999;
    expect(policy.canObserve(baseline, changed)).toBe(false);
    expect(policy.canObserve(baseline, { ...changed, input_revision: 2 })).toBe(true);
    time = 5000;
    expect(policy.canObserve(baseline, changed)).toBe(false);
    policy.recordAssessment(true);
    expect(policy.canObserve(baseline, changed)).toBe(false);
  });

  it('bounds model admission without terminating the lesson', () => {
    let time = 0;
    const policy = new TeachingObservationPolicy(() => time);
    for (let index = 0; index < 12; index += 1) {
      expect(policy.admitRun()).toBe(true);
    }
    expect(policy.admitRun()).toBe(false);
    time = 60000;
    expect(policy.admitRun()).toBe(true);
  });
});

it('ignores visual and geometry wakes while coalescing typing and held drags', () => {
  const policy = new TeachingObservationPolicy(() => 100);
  policy.admitRun();
  policy.recordAssessment(false);
  const observed = { ...baseline, relevant_revision: 1 };
  expect(policy.canObserve(observed, { ...observed, screen_revision: 2 })).toBe(false);
  expect(policy.canObserve(observed, { ...observed, relevant_revision: 2 })).toBe(false);
  expect(policy.readWakeReason(observed, { ...observed, relevant_revision: 2 })).toBe(
    'input_linked_pending_result',
  );
  expect(policy.canObserve(observed, { ...observed, screen_width: 1400 })).toBe(false);
  for (const quiet_ms of [0, 100, 499]) {
    expect(policy.canObserve(observed, { ...observed, input_revision: 4, quiet_ms })).toBe(false);
  }
  expect(policy.canObserve(observed, { ...observed, input_revision: 4, buttons_down: true })).toBe(
    false,
  );
  expect(policy.canObserve(observed, { ...observed, input_revision: 4, quiet_ms: 500 })).toBe(true);
});

it('allows two pending-result checks tied to settled input, without refilling on pending assessment', () => {
  let time = 0;
  const policy = new TeachingObservationPolicy(() => time);
  const afterInput = { ...baseline, input_revision: 2 };
  expect(policy.canObserve(baseline, afterInput)).toBe(true);
  policy.recordAssessment(false);
  time = 1000;
  expect(policy.canObserve(afterInput, afterInput)).toBe(true);
  policy.recordAssessment(false);
  time = 3000;
  expect(policy.canObserve(afterInput, afterInput)).toBe(true);
  policy.recordAssessment(false);
  time = 10000;
  expect(policy.canObserve(afterInput, afterInput)).toBe(false);
});
