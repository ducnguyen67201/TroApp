import { expect, it } from 'vitest';
import { StudentInteractionTracker } from '../../../../src/desktop/worker/observation/StudentInteractionTracker.js';
const bounds = { x: 0.1, y: 0.1, width: 0.1, height: 0.1 };
const point = { x: 0.15, y: 0.15 };

function click(tracker: StudentInteractionTracker) {
  tracker.recordActivity({ kind: 'press', point, button: 1 });
  tracker.recordActivity({ kind: 'release', point, button: 1 });
}

it('preserves clicks through typing and refreshes bounds even for the same checkpoint', () => {
  const tracker = new StudentInteractionTracker();
  click(tracker); // Input during initial inference is retained too.
  tracker.registerStep('step', { kind: 'click', target: bounds });
  click(tracker);
  tracker.recordActivity({ kind: 'key', point: null, button: null });
  expect(tracker.readEvidence().attempts.map((attempt) => attempt.kind)).toEqual([
    'click',
    'click',
    'key',
  ]);
  expect(tracker.readEvidence().attempts[1]?.destinationNear).toBe(true);
  tracker.registerStep('step', { kind: 'click', target: { ...bounds, x: 0.8 } });
  click(tracker);
  expect(tracker.readEvidence().attempts.at(-1)?.destinationNear).toBe(false);
  expect(tracker.readEvidence().attemptCount).toBe(3);
});
it('records complete drag endpoints, unpaired releases and bounded attempts without claiming success', () => {
  const tracker = new StudentInteractionTracker();
  tracker.registerStep('drag', {
    kind: 'drag',
    source: bounds,
    destination: { ...bounds, x: 0.6 },
  });
  tracker.recordActivity({ kind: 'press', point, button: 1 });
  tracker.recordActivity({ kind: 'drag', point, button: 1 });
  tracker.recordActivity({ kind: 'release', point: { x: 0.65, y: 0.15 }, button: 1 });
  expect(tracker.readEvidence().attempts[0]).toMatchObject({
    kind: 'drag',
    sourceNear: true,
    destinationNear: true,
  });
  tracker.recordActivity({ kind: 'release', point, button: 1 });
  expect(tracker.readEvidence().attempts.at(-1)?.kind).toBe('unpaired_release');
  for (let index = 0; index < 20; index += 1) {
    tracker.recordActivity({ kind: 'scroll', point, button: null });
  }
  expect(tracker.readEvidence().attempts).toHaveLength(12);
  expect(tracker.readEvidence().activitySequence).toBe(24);
  expect(tracker.readEvidence().limitation).toContain('not app acceptance');
});
