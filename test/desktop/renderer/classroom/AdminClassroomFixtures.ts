import {
  ClassroomPacing,
  ClassroomPhase,
  ClassroomStatus,
  SubmissionRequirement,
  type AdminClassroomDetail,
  type AdminClassroomSummary,
} from '#contracts/Classroom.js';

export const firstClassId = '11111111-1111-4111-8111-111111111111';

export const secondClassId = '22222222-2222-4222-8222-222222222222';

export const firstSessionId = '33333333-3333-4333-8333-333333333333';

export const secondSessionId = '44444444-4444-4444-8444-444444444444';

export function createAdminClassSummary(id = firstClassId): AdminClassroomSummary {
  return {
    schoolClass: {
      id,
      teacherId: 'another-teacher',
      name: id === firstClassId ? 'Class A' : 'Class B',
      courseRevisionId: '55555555-5555-4555-8555-555555555555',
    },
    teacherName: 'Another teacher',
    teacherEmail: 'teacher@example.test',
  };
}

export function createAdminClassDetail(
  id = firstClassId,
  sessionId = firstSessionId,
): AdminClassroomDetail {
  const summary = createAdminClassSummary(id);
  const activityId = '66666666-6666-4666-8666-666666666666';
  return {
    ...summary,
    course: {
      id: summary.schoolClass.courseRevisionId,
      ownerId: summary.schoolClass.teacherId,
      title: `${summary.schoolClass.name} course`,
      content: {
        modules: [
          {
            title: 'Module',
            lessons: [
              {
                title: 'Lesson',
                activities: [
                  {
                    id: activityId,
                    title: `${summary.schoolClass.name} activity`,
                    objective: 'Build a game.',
                    instructions: 'Connect the blocks.',
                    prerequisites: [],
                    criteria: [
                      { id: '77777777-7777-4777-8777-777777777777', description: 'Game runs.' },
                    ],
                    materials: [],
                    submission: SubmissionRequirement.NONE,
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    meetings: [firstSessionId, secondSessionId].map((meetingId) => ({
      id: meetingId,
      classId: id,
      status: meetingId === firstSessionId ? ClassroomStatus.LIVE : ClassroomStatus.ENDED,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.TEACHER,
      currentActivityId: activityId,
      contextVersion: 1,
    })),
    rosters: [
      {
        classSessionId: sessionId,
        students: [
          {
            studentId: 'student',
            name: `${summary.schoolClass.name} student ${sessionId === firstSessionId ? 'current' : 'past'}`,
            participation: null,
            attempts: [],
            submissions: [],
          },
        ],
      },
    ],
  };
}
