// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ClassroomInsightCommand,
  ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';
import { TeacherAssessmentForm } from '../../../../src/desktop/renderer/classroom/TeacherAssessmentForm.js';
import {
  createInsightAssessment,
  createInsightStatus,
  createStudentProgress,
  insightSessionId,
} from '../../ClassroomInsightDesktopFixtures.js';

afterEach(cleanup);

it('pins correction scope and the latest approved mapping without changing the task episode', async () => {
  const assessment = createInsightAssessment();
  const status = createInsightStatus(assessment);
  const firstMapping = status.mappings[0];
  if (!firstMapping) {
    throw new Error('Missing skill mapping');
  }
  status.mappings.push({ ...firstMapping, version: 2, sourceRevision: '5' });
  const send = vi
    .fn<(command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>>()
    .mockResolvedValue({ kind: 'failed', code: 'stale' });
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(TeacherAssessmentForm, {
        progress: { ...createStudentProgress(), assessments: [assessment] },
        status,
        classSessionId: insightSessionId,
        send,
        onSaved: () => {},
      }),
    }),
  );
  fireEvent.click(screen.getByText('Record a teacher check'));
  fireEvent.click(screen.getByRole('combobox', { name: 'Correct an earlier observation' }));
  fireEvent.click(screen.getByRole('option', { name: 'Countdown challenge · Teacher' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'What you observed' }), {
    target: { value: 'Teacher reviewed the saved task again.' },
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'Explain the result' }));
  fireEvent.click(screen.getByRole('option', { name: 'More evidence needed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save teacher check' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledOnce();
  });
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    kind: 'record-assessment',
    observedAt: assessment.observedAt,
    classSessionId: assessment.classSessionId,
    activityId: assessment.activityId,
    episodeId: assessment.episodeId,
    checkId: assessment.checkId,
    supersedesId: assessment.id,
    mappingVersion: 2,
  });
});
