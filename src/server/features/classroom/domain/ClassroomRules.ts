import {
  ClassroomFailure,
  ClassroomPacing,
  ClassroomStatus,
  type ClassMeeting,
  type CourseContent,
  type ClassroomActivity,
} from '#contracts/Classroom.js';

/** Safe business rejection; adapters map the code without exposing persistence errors. */
export class ClassroomError extends Error {
  constructor(readonly code: ClassroomFailure) {
    super(code);
  }
}

export function listActivities(content: CourseContent): ClassroomActivity[] {
  return content.modules.flatMap((module) => module.lessons.flatMap((lesson) => lesson.activities));
}

export function findActivity(content: CourseContent, activityId: string): ClassroomActivity {
  const activity = listActivities(content).find((candidate) => candidate.id === activityId);
  if (!activity) {
    throw new ClassroomError(ClassroomFailure.NOT_FOUND);
  }
  return activity;
}

export function requireLiveMeeting(meeting: ClassMeeting): void {
  if (meeting.status !== ClassroomStatus.LIVE) {
    throw new ClassroomError(ClassroomFailure.STALE);
  }
}

export function canAccessActivity(meeting: ClassMeeting, activityId: string): boolean {
  return meeting.pacing === ClassroomPacing.STUDENT || meeting.currentActivityId === activityId;
}

export function validateScratchProjectLink(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.hostname === 'scratch.mit.edu' &&
    /^\/projects\/[1-9]\d*\/?$/.test(url.pathname) &&
    !url.search &&
    !url.hash &&
    !url.port &&
    !url.username &&
    !url.password
  );
}
