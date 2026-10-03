import { expect, it } from 'vitest';
import {
  PresentTeachingStepSchema,
  TeachingPresentationReceiptSchema,
} from '#contracts/TeachingStep.js';
const id = '11111111-1111-4111-8111-111111111111';
const target = { label: 'Address bar', bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 } };
const proposal = {
  captureId: 'current',
  goalRevisionId: id,
  checkpointId: null,
  previousStepAssessment: null,
  assessmentEvidence: 'Browser is visible',
  instruction: 'Click the address bar.',
  expectedResult: 'Field focused',
  action: { kind: 'click', target },
};
it.each([
  { kind: 'click', target },
  { kind: 'drag', source: target, destination: target },
  { kind: 'scroll', viewport: target, direction: 'down' },
  { kind: 'highlight', target },
  { kind: 'type', target, focused: true, text: 'youtube.com', submit: true },
  { kind: 'keyboard', shortcut: 'Command+Space' },
  { kind: 'wait', evidence: 'Loading indicator visible' },
])('accepts a complete typed $kind action without independent cues', (action) => {
  expect(PresentTeachingStepSchema.safeParse({ ...proposal, action }).success).toBe(true);
});
it('rejects missing actions, arbitrary cue overrides and rectangles extending beyond the capture', () => {
  expect(PresentTeachingStepSchema.safeParse({ ...proposal, action: null }).success).toBe(false);
  expect(PresentTeachingStepSchema.safeParse({ ...proposal, cue: null }).success).toBe(false);
  expect(
    PresentTeachingStepSchema.safeParse({
      ...proposal,
      action: { kind: 'click', target: { ...target, bounds: { ...target.bounds, x: 0.8 } } },
    }).success,
  ).toBe(false);
});
it('cannot authorize a spatial presentation with only a message acknowledgement', () => {
  const receipt = {
    lessonId: id,
    stepId: id,
    presentationId: id,
    goalRevisionId: id,
    captureId: 'current',
    messagePresented: true,
    drawingPresented: false,
    textOnly: false,
    interrupted: false,
  };
  expect(TeachingPresentationReceiptSchema.safeParse(receipt).success).toBe(false);
  expect(
    TeachingPresentationReceiptSchema.safeParse({
      ...receipt,
      drawingPresented: true,
      interrupted: true,
    }).success,
  ).toBe(true);
});
