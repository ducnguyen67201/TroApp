// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PracticeCheckPanel } from '../../../../src/desktop/renderer/classroom/PracticeCheckPanel.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';
import { createPracticeCheckpoint } from '../../../server/features/classroom/PracticeFixtures.js';
import type { PracticeCommand, PracticeReply, PracticeRecord } from '#contracts/PracticeCheck.js';
import { randomUUID } from 'node:crypto';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('requires explicit evidence, shows loading, and confirms exact-version hand-in', async () => {
  const context = createTeachingContext(),
    rubric = createPracticeCheckpoint();
  context.meeting.phase = 'practice';
  context.activity.practiceCheckpoints = [rubric];
  const onHelp = vi.fn<(message: string) => void>();
  let complete: (reply: PracticeReply) => void = () => {};
  const saved: { record: PracticeRecord | null } = { record: null };
  const controlPractice = vi
    .fn<(command: PracticeCommand) => Promise<PracticeReply>>()
    .mockImplementation(async (command) => {
      if (command.kind === 'history') {
        return { kind: 'history', checks: saved.record ? [saved.record] : [], submissions: [] };
      }
      if (command.kind === 'check') {
        saved.record = {
          id: randomUUID(),
          requestId: command.requestId,
          snapshotId: randomUUID(),
          attemptId: context.attempt.id,
          checkpointId: rubric.id,
          rubric,
          status: 'completed',
          finding: 'needs_changes',
          results: rubric.criteria.map((criterion) => ({
            criterionId: criterion.id,
            finding: 'needs_changes',
            feedback: 'Show the greeting',
            evidenceIds: [],
          })),
          evaluator: 'fake/v1',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          evidence: command.evidence.map((item) => ({
            id: item.id,
            kind: item.kind,
            name: item.name,
            byteCount: 3,
            digest: 'a'.repeat(64),
          })),
        };
        return new Promise((resolve) => {
          complete = resolve;
        });
      }
      if (command.kind === 'help') {
        return { kind: 'help', message: 'Observe fresh work and guide this gap' };
      }
      if (command.kind === 'submit-snapshot') {
        return {
          kind: 'submitted',
          submission: {
            id: randomUUID(),
            studentId: 'student',
            attemptId: context.attempt.id,
            checkpointId: rubric.id,
            snapshotId: randomUUID(),
            checkId: command.checkId,
            sequence: 1,
            submittedAt: new Date().toISOString(),
          },
        };
      }
      return { kind: 'failed', code: 'invalid' };
    });
  vi.stubGlobal('tro', { controlPractice });
  const panel: ReactElement = createElement(MantineProvider, {
    env: 'test',
    children: createElement(LocaleProvider, {
      children: createElement(PracticeCheckPanel, {
        context,
        practiceReview: {
          requestId: randomUUID(),
          classId: context.meeting.classId,
          participationId: context.participation.id,
          activityId: context.activity.id,
          attemptId: context.attempt.id,
          contextVersion: context.meeting.contextVersion,
        },
        t: (english) => english,
        onAskForHelp: onHelp,
      }),
    }),
  });
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  render(panel);
  await waitFor(() => {
    expect(controlPractice).toHaveBeenCalledOnce();
  });
  const review = await screen.findByRole('dialog', { name: 'Review your practice' });
  expect(within(review).getByRole('button', { name: 'Check my work' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(controlPractice.mock.calls.filter(([command]) => command.kind === 'check')).toHaveLength(
    0,
  );
  fireEvent.click(within(review).getByRole('button', { name: 'Edit evidence' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(screen.getByRole('button', { name: 'Check my work' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Your work or code'), { target: { value: 'Hello' } });
  const checkButton = screen.getByRole('button', { name: 'Check my work' });
  fireEvent.click(checkButton);
  expect(checkButton).toHaveProperty('disabled', true);
  await waitFor(() => {
    expect(saved.record).not.toBeNull();
  });
  if (!saved.record) {
    throw new Error('No saved record.');
  }
  complete({ kind: 'check', check: saved.record });
  expect(await screen.findByRole('button', { name: 'Hand in this version' })).toBeTruthy();
  expect(onHelp).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Help me with this' })[0] ??
      screen.getByText('Missing help'),
  );
  await waitFor(() => {
    expect(onHelp).toHaveBeenCalledWith('Observe fresh work and guide this gap');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Hand in this version' }));
  expect(
    controlPractice.mock.calls.filter(([command]) => command.kind === 'submit-snapshot'),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm hand-in' }));
  await waitFor(() => {
    expect(
      controlPractice.mock.calls.filter(([command]) => command.kind === 'submit-snapshot'),
    ).toHaveLength(1);
  });
});
