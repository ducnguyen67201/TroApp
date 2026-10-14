import { expect, it, vi } from 'vitest';
import {
  AnalyticsEvent,
  AnalyticsActionOutcome,
  AnalyticsClassroomOperation,
  type AnalyticsEventInput,
} from '#contracts/Analytics.js';
import { recordClassroomUsage } from '../../../src/desktop/main/RecordProductUsage.js';

it('excludes routine classroom reads while counting accepted and failed explicit operations', () => {
  const capture = vi.fn<(event: AnalyticsEventInput) => void>();
  for (const command of [
    'home',
    'context',
    'resume',
    'session-roster',
    'history',
    'read-material-source',
  ] as const) {
    recordClassroomUsage(capture, command, 'ok', 2.4);
  }
  expect(capture).not.toHaveBeenCalled();
  recordClassroomUsage(capture, 'join', 'context', 150.6);
  recordClassroomUsage(capture, 'check', 'failed', 25);
  recordClassroomUsage(capture, 'submit-snapshot', 'submitted', 40);
  expect(capture.mock.calls.map(([event]) => event)).toEqual([
    {
      event: AnalyticsEvent.CLASSROOM_ACTION_FINISHED,
      operation: AnalyticsClassroomOperation.JOIN,
      outcome: AnalyticsActionOutcome.SUCCEEDED,
      durationMs: 151,
    },
    {
      event: AnalyticsEvent.CLASSROOM_ACTION_FINISHED,
      operation: AnalyticsClassroomOperation.CHECK,
      outcome: AnalyticsActionOutcome.FAILED,
      durationMs: 25,
    },
    {
      event: AnalyticsEvent.CLASSROOM_ACTION_FINISHED,
      operation: AnalyticsClassroomOperation.SUBMIT,
      outcome: AnalyticsActionOutcome.SUCCEEDED,
      durationMs: 40,
    },
  ]);
});
