// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ClassroomInsightCommand,
  ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';
import { InsightDefinitionEditor } from '../../../../src/desktop/renderer/classroom/InsightDefinitionEditor.js';
import {
  createInsightAssessment,
  createInsightStatus,
  insightClassId,
  insightSessionId,
} from '../../ClassroomInsightDesktopFixtures.js';

afterEach(cleanup);

it('adds a reviewed comparable variant while preserving the original skill and scoring standard', async () => {
  const status = createInsightStatus(createInsightAssessment());
  const mapping = status.mappings[0];
  const original = mapping?.variants[0];
  if (!mapping || !original) {
    throw new Error('Missing approved definition');
  }
  const send = vi
    .fn<(command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>>()
    .mockResolvedValue({ kind: 'failed', code: 'unavailable' });
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(InsightDefinitionEditor, {
        classId: insightClassId,
        classSessionId: insightSessionId,
        status,
        send,
        onSaved: () => {},
      }),
    }),
  );
  fireEvent.click(screen.getByText('Teacher learning definitions'));
  fireEvent.click(screen.getByRole('combobox', { name: 'Add a task to an existing skill' }));
  fireEvent.click(screen.getByRole('option', { name: mapping.title }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Task for this skill' }));
  fireEvent.click(screen.getByRole('option', { name: 'Countdown challenge' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'New task variant name' }), {
    target: { value: 'Count from ten' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Approved task instructions' }), {
    target: { value: 'Trace a loop from ten to zero.' },
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'Comparable criteria' }));
  fireEvent.click(screen.getByRole('option', { name: 'Update the counter' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Task with the same scoring standard' }));
  fireEvent.click(screen.getByRole('option', { name: original.title }));
  expect(
    screen
      .getByRole('button', { name: 'Approve comparable task variant' })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: 'I reviewed these tasks and confirm the same comparison and scoring standard applies',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Approve comparable task variant' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledOnce();
  });
  const command = send.mock.calls[0]?.[0];
  expect(command).toMatchObject({
    kind: 'approve-mapping',
    id: mapping.id,
    expectedVersion: mapping.version,
    skillId: mapping.skillId,
    standardRevisionId: mapping.standardRevisionId,
  });
  if (command?.kind !== 'approve-mapping') {
    throw new Error('Missing mapping command');
  }
  expect(command.variants[0]).toEqual(original);
  expect(command.variants[1]).toMatchObject({
    title: 'Count from ten',
    comparisonGroupId: original.comparisonGroupId,
    scoringRevisionId: original.scoringRevisionId,
  });
  expect(command.variants[1]?.id).not.toBe(original.id);
});
