import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents';
import { TeachingLessonContext } from '../../../../src/desktop/worker/teaching/TeachingLessonContext.js';
import { createLesson } from './TeachingTestFixture.js';
it('retains the original request, scoped answer and intact bounded tool/result exchanges', () => {
  const lesson = new TeachingLessonContext('Design the whole ERD');
  lesson.askQuestion('Which database?');
  expect(lesson.submitAnswer(randomUUID(), 'Sales')).toBe(false);
  expect(lesson.submitAnswer(lesson.id, 'Sales')).toBe(true);
  expect(lesson.submitAnswer(lesson.id, 'Replacement')).toBe(false);
  // Building input does not consume the answer: aborted SDK runs can retry.
  expect(JSON.stringify(lesson.buildInput('answered', null))).toContain('Sales');
  expect(lesson.hasAnswer()).toBe(true);
  for (let index = 0; index < 8; index += 1) {
    const input = lesson.buildInput('progress', null);
    const exchange: AgentInputItem[] = [
      { type: 'function_call', name: 'list_windows', callId: String(index), arguments: '{}' },
      {
        type: 'function_call_result',
        status: 'completed',
        name: 'list_windows',
        callId: String(index),
        output: [{ type: 'input_text', text: `exchange-${String(index)}` }],
      },
    ];
    lesson.recordReply([...input, ...exchange], input.length);
  }
  const packet = JSON.stringify(lesson.buildInput('next', null));
  expect(packet).toContain('Design the whole ERD');
  expect(packet).toContain('exchange-7');
  expect(packet).toContain('exchange-6');
  expect(packet).not.toContain('exchange-5');
  expect(lesson.hasAnswer()).toBe(false);
});
it('revises goals explicitly and accepts only current evidence for every criterion', () => {
  const { lesson, goal, capture } = createLesson();
  expect(
    lesson.defineGoal({
      purpose: 'walkthrough',
      outcome: 'Different goal',
      criteria: ['Chrome open'],
    }),
  ).toMatchObject({ admitted: false });
  const decision = {
    disposition: 'complete' as const,
    captureId: 'fresh',
    goalRevisionId: goal.id,
    presentationId: null,
    observationSummary: 'YouTube home',
    message: 'Done',
    reason: null,
    goalEvidence: [
      {
        criterionId: goal.criteria[0]?.id ?? '',
        captureId: 'fresh',
        observation: 'YouTube home visible',
      },
    ],
  };
  expect(lesson.hasReachedGoal(decision)).toBe(true);
  lesson.recordObservation(capture('new'));
  expect(lesson.hasReachedGoal(decision)).toBe(false);
  expect(
    lesson.reviseGoal({
      previousRevisionId: goal.id,
      captureId: 'fresh',
      reason: 'Outdated',
      definition: {
        purpose: 'walkthrough',
        outcome: 'YouTube open',
        criteria: ['YouTube page visible'],
      },
    }),
  ).toMatchObject({ admitted: false });
  expect(
    lesson.reviseGoal({
      previousRevisionId: goal.id,
      captureId: 'new',
      reason: 'Clarify home page result',
      definition: {
        purpose: 'walkthrough',
        outcome: 'YouTube open',
        criteria: ['YouTube page visible'],
      },
    }),
  ).toMatchObject({ admitted: true });
  expect(lesson.readGoal()?.criteria[0]?.id).not.toBe(goal.criteria[0]?.id);
  expect(JSON.stringify(lesson.buildInput('revised', null))).toContain('Open YouTube');
});
it('keeps failure evidence without freezing instruction wording and rejects unknown checkpoints', () => {
  const { lesson, proposal, receipt } = createLesson();
  expect(lesson.canPresent(proposal)).toBeNull();
  const message = lesson.reserveMessage(proposal);
  lesson.commitPresentedStep(proposal, { ...receipt, stepId: message.stepId }, message);
  expect(
    lesson.canPresent({
      ...proposal,
      checkpointId: message.stepId,
      instruction: 'Select the address field.',
    }),
  ).toBeNull();
  expect(lesson.canPresent({ ...proposal, checkpointId: randomUUID() })).toBe('unknown_checkpoint');
  lesson.recordOperation({ operation: 'presentation_refused', reason: 'target_changed' });
  const packet = JSON.stringify(lesson.buildInput('repair', { attempts: [] }));
  expect(packet).toContain('target_changed');
  expect(packet).toContain('step_presented');
});

it('requires acknowledged requested highlights for a tour, separately from walkthrough screen results', () => {
  const { lesson, goal, proposal, receipt } = createLesson();
  lesson.reviseGoal({
    previousRevisionId: goal.id,
    captureId: 'fresh',
    reason: 'The student requested a tour',
    definition: {
      purpose: 'tour',
      outcome: 'Explain the address bar',
      criteria: ['Address bar highlighted'],
    },
  });
  const tourGoal = lesson.readGoal();
  if (!tourGoal) {
    throw new Error('Tour goal missing');
  }
  const decision = {
    disposition: 'complete' as const,
    presentationId: null,
    goalRevisionId: tourGoal.id,
    captureId: 'fresh',
    message: 'Tour finished',
    reason: null,
    observationSummary: 'Address bar visible',
    goalEvidence: [
      {
        criterionId: tourGoal.criteria[0]?.id ?? '',
        captureId: 'fresh',
        observation: 'Requested address bar demonstrated',
      },
    ],
  };
  expect(lesson.hasReachedGoal(decision)).toBe(false);
  const tour = {
    ...proposal,
    goalRevisionId: tourGoal.id,
    action: {
      kind: 'highlight' as const,
      target: { label: 'Address bar', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 } },
    },
  };
  const message = lesson.reserveMessage(tour);
  lesson.commitPresentedStep(
    tour,
    { ...receipt, goalRevisionId: tourGoal.id, stepId: message.stepId },
    message,
  );
  expect(lesson.hasReachedGoal(decision)).toBe(true);
});

it('evicts oversized material exchanges as intact groups', () => {
  const lesson = new TeachingLessonContext('Help me print');
  const input = lesson.buildInput('request', null);
  const exchange: AgentInputItem[] = [
    {
      type: 'function_call',
      name: 'read_class_material_source',
      callId: 'oversized',
      arguments: '{}',
    },
    {
      type: 'function_call_result',
      name: 'read_class_material_source',
      callId: 'oversized',
      status: 'completed',
      output: '漢字 '.repeat(10000),
    },
  ];
  lesson.recordReply([...input, ...exchange], input.length);
  const retained = JSON.stringify(lesson.buildInput('continue', null));
  expect(retained).not.toContain('oversized');
  expect(retained).toContain('Help me print');
});

it('accepts one follow-up during local activity waiting and refuses it while processing', () => {
  const lesson = new TeachingLessonContext('Open the requested page');
  expect(lesson.submitAnswer(lesson.id, 'Explain this')).toBe(false);
  lesson.setWaitingForStudent(true);
  expect(lesson.canAnswer()).toBe(false);
  expect(lesson.submitAnswer(randomUUID(), 'Explain this')).toBe(false);
  expect(lesson.submitAnswer(lesson.id, 'Explain this')).toBe(true);
  expect(lesson.submitAnswer(lesson.id, 'Duplicate')).toBe(false);
  expect(JSON.stringify(lesson.buildInput('follow-up', null))).toContain('Explain this');
  lesson.setWaitingForStudent(false);
  lesson.recordReply([], 0);
  expect(lesson.submitAnswer(lesson.id, 'New message while processing')).toBe(false);
});
