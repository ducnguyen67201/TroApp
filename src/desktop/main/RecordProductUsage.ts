import {
  AnalyticsActionOutcome,
  AnalyticsClassroomOperation,
  AnalyticsEvent,
  type AnalyticsEventInput,
} from '#contracts/Analytics.js';
import type { ClassroomCommand, ClassroomReply } from '#contracts/Classroom.js';
import type { PracticeCommand, PracticeReply } from '#contracts/PracticeCheck.js';

/** Only explicit student/teacher actions count; background reads and lease refreshes stay quiet. */
export function recordClassroomUsage(
  capture: (event: AnalyticsEventInput) => void,
  command: ClassroomCommand['kind'] | PracticeCommand['kind'],
  reply: ClassroomReply['kind'] | PracticeReply['kind'],
  durationMs: number,
): void {
  let operation: (typeof AnalyticsClassroomOperation)[keyof typeof AnalyticsClassroomOperation];
  switch (command) {
    case 'join':
      operation = AnalyticsClassroomOperation.JOIN;
      break;
    case 'leave':
      operation = AnalyticsClassroomOperation.LEAVE;
      break;
    case 'submit-work':
    case 'submit-snapshot':
      operation = AnalyticsClassroomOperation.SUBMIT;
      break;
    case 'check':
      operation = AnalyticsClassroomOperation.CHECK;
      break;
    case 'start-session':
      operation = AnalyticsClassroomOperation.START;
      break;
    case 'end-session':
      operation = AnalyticsClassroomOperation.END;
      break;
    default:
      return;
  }
  capture({
    event: AnalyticsEvent.CLASSROOM_ACTION_FINISHED,
    operation,
    outcome: reply === 'failed' ? AnalyticsActionOutcome.FAILED : AnalyticsActionOutcome.SUCCEEDED,
    durationMs: Math.round(durationMs),
  });
}
