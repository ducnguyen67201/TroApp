/** Selects collection scope without changing teacher or student authorization. */
export interface ClassroomInsightPolicy {
  captureClassIds: readonly string[];
  captureAllClasses?: boolean;
}

export function canCaptureClassroomLearning(
  policy: ClassroomInsightPolicy,
  classId: string,
): boolean {
  return policy.captureAllClasses === true || policy.captureClassIds.includes(classId);
}

export function hasClassroomLearningCapture(policy: ClassroomInsightPolicy): boolean {
  return policy.captureAllClasses === true || policy.captureClassIds.length > 0;
}
