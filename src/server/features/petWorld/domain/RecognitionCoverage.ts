import type { PetGarden, PetRecognition, PetRecognitionCoverage } from '#contracts/PetWorld.js';
import { AccountRole } from '#contracts/AccountRole.js';
import type { PetRosterStudent } from './PetWorldState.js';

export function calculateGardenProgress(classroomMoments: number): PetGarden {
  return { classroomMoments, gardenMilestone: Math.floor(classroomMoments / 5) };
}

/** Recognition describes teacher choices, never mastery, attention, or motivation. */
export function calculateRecognitionCoverage(
  roster: readonly PetRosterStudent[],
  recognitions: readonly PetRecognition[],
): PetRecognitionCoverage {
  const eligible = new Set(
    roster
      .filter((student) => student.role === AccountRole.STUDENT)
      .map((student) => student.studentId),
  );
  const recognizedStudentIds = [
    ...new Set(
      recognitions
        .filter((recognition) => !recognition.correction && eligible.has(recognition.studentId))
        .map((recognition) => recognition.studentId),
    ),
  ].sort();
  const classroomMoments = new Set(
    recognitions
      .filter((recognition) => !recognition.correction)
      .map((recognition) => recognition.batchId),
  ).size;
  return {
    eligibleStudents: eligible.size,
    recognizedStudents: recognizedStudentIds.length,
    recognizedStudentIds,
    ...calculateGardenProgress(classroomMoments),
  };
}
