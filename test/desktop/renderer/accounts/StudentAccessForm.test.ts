// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentAccessForm } from '../../../../src/desktop/renderer/accounts/StudentAccessForm.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  StudentAccessReplySchema,
  type StudentAccessCommand,
  type StudentAccessReply,
  type StudentEnrollment,
} from '#contracts/StudentAccess.js';

beforeEach(() => {
  localStorage.setItem('tro.desktop.locale', 'en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function showForm(control: (command: StudentAccessCommand) => Promise<StudentAccessReply>) {
  Object.defineProperty(window, 'tro', {
    configurable: true,
    value: { controlStudentAccess: control },
  });
  const enrollStudent = vi
    .fn<(command: StudentEnrollment) => Promise<StudentAccessReply>>()
    .mockResolvedValue({ kind: 'failed', message: 'Synthetic retryable failure.' });
  const success = vi.fn<() => void>();
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(StudentAccessForm, {
          controller: { enrollStudent },
          onSuccess: success,
        }),
      }),
    }),
  );
  return { enrollStudent, success };
}

describe('student onboarding form', () => {
  it('preserves supplier IDs and the operation ID across a failed submission', async () => {
    const ready = StudentAccessReplySchema.parse({
      kind: 'ready',
      context: {
        schoolId: '11111111-1111-4111-8111-111111111111',
        schoolName: 'CodeSpace',
        classId: '22222222-2222-4222-8222-222222222222',
        className: 'Scratch',
        mode: 'personal',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });
    const control = vi
      .fn<(command: StudentAccessCommand) => Promise<StudentAccessReply>>()
      .mockResolvedValue(ready);
    const f = showForm(control);
    const id = await screen.findByLabelText(/Student ID/);
    fireEvent.change(id, { target: { value: '001aBc' } });
    fireEvent.change(screen.getByLabelText(/What should Tro call you/), {
      target: { value: 'Minh' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start learning' }));
    await waitFor(() => {
      expect(f.enrollStudent).toHaveBeenCalledOnce();
    });
    expect(f.enrollStudent.mock.calls[0]?.[0].externalId).toBe('001aBc');
    await screen.findByText('Synthetic retryable failure.');
    fireEvent.click(screen.getByRole('button', { name: 'Start learning' }));
    await waitFor(() => {
      expect(f.enrollStudent).toHaveBeenCalledTimes(2);
    });
    expect(f.enrollStudent.mock.calls[0]?.[0]).toEqual(f.enrollStudent.mock.calls[1]?.[0]);
    expect(f.success).not.toHaveBeenCalled();
  });

  it('does not ask for email and keeps the activation operation stable for retries', async () => {
    const control = vi
      .fn<(command: StudentAccessCommand) => Promise<StudentAccessReply>>()
      .mockResolvedValueOnce({ kind: 'unconfigured' })
      .mockResolvedValue({ kind: 'failed', message: 'Synthetic service failure.' });
    showForm(control);
    fireEvent.change(await screen.findByLabelText(/Class setup code/), {
      target: { value: 'ABCDEFGHIJKLMNOP' },
    });
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Synthetic service failure.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(control).toHaveBeenCalledTimes(3);
    });
    expect(control.mock.calls[1]?.[0]).toEqual(control.mock.calls[2]?.[0]);
  });
});
