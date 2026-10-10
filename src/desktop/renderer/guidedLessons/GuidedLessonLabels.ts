import { LessonStatus } from '#contracts/GuidedLessons.js';

const statusLabels: Readonly<Record<LessonStatus, string>> = {
  [LessonStatus.ADMITTED]: 'Preparing',
  [LessonStatus.DRAFTING]: 'Drafting',
  [LessonStatus.REVIEWING_CONTENT]: 'Reviewing content',
  [LessonStatus.REPAIRING_CONTENT]: 'Repairing content',
  [LessonStatus.RECHECKING_CONTENT]: 'Reviewing content',
  [LessonStatus.AWAITING_SCRIPT_APPROVAL]: 'Awaiting script approval',
  [LessonStatus.SYNTHESIZING]: 'Synthesizing',
  [LessonStatus.RENDERING]: 'Rendering',
  [LessonStatus.REVIEWING_VISUALS]: 'Reviewing visuals',
  [LessonStatus.REPAIRING_VISUALS]: 'Reviewing visuals',
  [LessonStatus.RECHECKING_VISUALS]: 'Reviewing visuals',
  [LessonStatus.PREVIEW_READY]: 'Preview ready',
  [LessonStatus.RELEASED]: 'Released',
  [LessonStatus.NEEDS_TEACHER_INPUT]: 'Needs teacher input',
  [LessonStatus.BUDGET_BLOCKED]: 'Budget blocked',
  [LessonStatus.USAGE_UNCERTAIN]: 'Usage uncertain',
  [LessonStatus.FAILED]: 'Failed',
  [LessonStatus.CANCELLED]: 'Cancelled',
};

export function readLessonStatusLabel(status: LessonStatus): string {
  return statusLabels[status];
}

export function isGuidedLessonRunning(status: LessonStatus): boolean {
  return (
    status === LessonStatus.ADMITTED ||
    status === LessonStatus.DRAFTING ||
    status === LessonStatus.REVIEWING_CONTENT ||
    status === LessonStatus.REPAIRING_CONTENT ||
    status === LessonStatus.RECHECKING_CONTENT ||
    status === LessonStatus.SYNTHESIZING ||
    status === LessonStatus.RENDERING ||
    status === LessonStatus.REVIEWING_VISUALS ||
    status === LessonStatus.REPAIRING_VISUALS ||
    status === LessonStatus.RECHECKING_VISUALS
  );
}
