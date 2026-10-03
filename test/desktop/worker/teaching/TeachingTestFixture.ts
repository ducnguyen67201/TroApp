import { randomUUID } from 'node:crypto';
import type { PresentTeachingStep } from '#contracts/TeachingStep.js';
import { TeachingLessonContext } from '../../../../src/desktop/worker/teaching/TeachingLessonContext.js';
export const bounds = { x: 0.1, y: 0.2, width: 0.1, height: 0.05 };

export function createLesson() {
  const lesson = new TeachingLessonContext('Open YouTube');
  lesson.defineGoal({
    purpose: 'walkthrough',
    outcome: 'YouTube open',
    criteria: ['YouTube is visibly loaded'],
  });
  const capture = (id: string) => ({
    content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
    structuredContent: {
      capture_id: id,
      display: 'primary',
      screen_width: 1000,
      screen_height: 800,
      screenshot_width: 1000,
      screenshot_height: 800,
      scale_factor: 1,
    },
  });
  lesson.recordObservation(capture('fresh'));
  const goal = lesson.readGoal();
  if (!goal) {
    throw new Error('Fixture goal missing');
  }
  const proposal: PresentTeachingStep = {
    captureId: 'fresh',
    goalRevisionId: goal.id,
    checkpointId: null,
    previousStepAssessment: null,
    assessmentEvidence: 'A browser is visible',
    instruction: 'Click the address bar.',
    expectedResult: 'Address bar is focused',
    action: { kind: 'click', target: { label: 'Address bar', bounds } },
  };
  return {
    lesson,
    goal,
    proposal,
    capture,
    receipt: {
      lessonId: lesson.id,
      stepId: randomUUID(),
      presentationId: randomUUID(),
      goalRevisionId: goal.id,
      captureId: 'fresh',
      messagePresented: true as const,
      drawingPresented: true,
      textOnly: false,
      interrupted: false,
    },
  };
}
