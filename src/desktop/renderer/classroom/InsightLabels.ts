import {
  AssistanceContext,
  InsightFailure,
  type ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';

export function formatInsightFailure(
  reply: Extract<ClassroomInsightReply, { kind: 'failed' }>,
): string {
  switch (reply.code) {
    case InsightFailure.FORBIDDEN:
      return 'Learning insights are unavailable for this class or account.';
    case InsightFailure.STALE:
      return 'This view changed. Refresh before trying again.';
    case InsightFailure.REMOVED:
      return 'This learning history has been removed.';
    case InsightFailure.LIMIT:
      return 'Choose a shorter reporting period.';
    case InsightFailure.INVALID:
      return 'Check the selected task and form fields.';
    default:
      return 'Learning insights could not be loaded. Try again.';
  }
}

export function formatAssistance(assistance: string, confirmed = false): string {
  if (confirmed && assistance === AssistanceContext.UNAIDED) {
    return 'Teacher-confirmed unaided';
  }
  switch (assistance) {
    case AssistanceContext.HINT:
      return 'With a hint';
    case AssistanceContext.DEMONSTRATION:
      return 'With a demonstration';
    case AssistanceContext.GROUP:
      return 'Group work';
    case AssistanceContext.UNAIDED:
      return 'Recorded as unaided';
    default:
      return 'Support unknown';
  }
}
