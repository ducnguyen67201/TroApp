// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentDeviceMode, StudentQrLimits } from '#contracts/StudentIdentity.js';
import { StudentAccessForm } from '../../../../src/desktop/renderer/accounts/StudentAccessForm.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  StudentAccessReplySchema,
  type StudentAccessCommand,
  type StudentAccessReply,
  type StudentEnrollment,
} from '#contracts/StudentAccess.js';

const scannedQr = vi.hoisted(() => ({ value: '' }));
vi.mock('../../../../src/desktop/renderer/accounts/StudentQrScanner.js', () => ({
  StudentQrScanner: ({ onRead }: { onRead: (value: string) => void }) =>
    createElement(
      'button',
      {
        onClick: () => {
          onRead(scannedQr.value);
        },
      },
      'Read synthetic QR',
    ),
}));

beforeEach(() => {
  localStorage.setItem('tro.desktop.locale', 'en');
  scannedQr.value = '';
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function showForm(
  control: (command: StudentAccessCommand) => Promise<StudentAccessReply>,
  mode: StudentDeviceMode = StudentDeviceMode.SHARED,
) {
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
          mode,
        }),
      }),
    }),
  );
  return { enrollStudent, success };
}

describe('student onboarding form', () => {
  it('lets a returning student submit their ID without entering a name', async () => {
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
    const f = showForm(() => Promise.resolve(ready));
    f.enrollStudent.mockResolvedValue(
      StudentAccessReplySchema.parse({
        kind: 'signed-in',
        user: {
          id: 'existing-student',
          name: 'Minh',
          email: null,
          learner: {
            schoolId: '11111111-1111-4111-8111-111111111111',
            schoolName: 'CodeSpace',
            classId: '22222222-2222-4222-8222-222222222222',
            externalId: '001aBc',
            mode: 'personal',
            provisional: true,
          },
        },
      }),
    );
    fireEvent.change(await screen.findByLabelText(/Student ID/), { target: { value: '001aBc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start learning' }));
    await waitFor(() => {
      expect(f.success).toHaveBeenCalledOnce();
    });
    expect(f.enrollStudent.mock.calls[0]?.[0]).toMatchObject({ externalId: '001aBc', name: '' });
  });

  it.each(['https://school.example.test/card?id=001Ab', 'BEGIN:VCARD\nFN:Minh\nEND:VCARD'])(
    'accepts decoded QR contents as data and submits the exact value: %s',
    async (value) => {
      scannedQr.value = value;
      const organizationId = '11111111-1111-4111-8111-111111111111';
      const ready = StudentAccessReplySchema.parse({
        kind: 'ready',
        context: {
          schoolId: organizationId,
          organizationId,
          schoolName: 'School',
          classId: null,
          className: null,
          mode: 'personal',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      });
      const f = showForm(() => Promise.resolve(ready));
      fireEvent.click(await screen.findByRole('button', { name: 'Scan your student card' }));
      fireEvent.click(screen.getByRole('button', { name: 'Read synthetic QR' }));
      expect(screen.getByLabelText(/Student ID or QR text/)).toHaveProperty('value', value);
      expect(screen.queryByRole('link')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Start learning' }));
      await waitFor(() => {
        expect(f.enrollStudent).toHaveBeenCalledWith(
          expect.objectContaining({ externalId: value }),
        );
      });
    },
  );

  it('reports only safe rejection diagnostics for an oversized decoded QR', async () => {
    scannedQr.value = 'x'.repeat(StudentQrLimits.TEXT_CHARACTERS + 1);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const ready = StudentAccessReplySchema.parse({
      kind: 'ready',
      context: {
        schoolId: organizationId,
        organizationId,
        schoolName: 'School',
        classId: null,
        className: null,
        mode: 'personal',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });
    const f = showForm(() => Promise.resolve(ready));
    fireEvent.click(await screen.findByRole('button', { name: 'Scan your student card' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read synthetic QR' }));
    expect(screen.getByRole('alert').textContent).toContain('non-empty text');
    expect(warning).toHaveBeenCalledExactlyOnceWith('student.qr.rejected', {
      stage: 'decoded-text-validation',
      reason: 'too_big',
      characters: scannedQr.value.length,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain(scannedQr.value);
    expect(f.enrollStudent).not.toHaveBeenCalled();
    warning.mockRestore();
  });

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
    fireEvent.change(await screen.findByLabelText(/Organization activation code/), {
      target: { value: 'TRO-ABCDEFGHIJKLMNOP' },
    });
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activate computer' }));
    await screen.findByText('Synthetic service failure.');
    fireEvent.click(screen.getByRole('button', { name: 'Activate computer' }));
    await waitFor(() => {
      expect(control).toHaveBeenCalledTimes(3);
    });
    expect(control.mock.calls[1]?.[0]).toEqual(control.mock.calls[2]?.[0]);
  });

  it('authorizes personal QR access without asking the user to sign out Google accounts', async () => {
    const control = vi
      .fn<(command: StudentAccessCommand) => Promise<StudentAccessReply>>()
      .mockResolvedValue({ kind: 'unconfigured' });
    showForm(control, StudentDeviceMode.PERSONAL);
    const field = await screen.findByLabelText(/Organization activation code/);
    expect(screen.getByText(/Your saved Google accounts stay available/)).toBeTruthy();
    fireEvent.change(field, { target: { value: 'TRO-ABCDEFGHIJKLMNOP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate computer' }));
    await waitFor(() => {
      expect(control).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'activate',
          mode: StudentDeviceMode.PERSONAL,
        }),
      );
    });
  });

  it('explains why a class invitation cannot activate a company computer and accepts a full computer code', async () => {
    const control = vi
      .fn<(command: StudentAccessCommand) => Promise<StudentAccessReply>>()
      .mockResolvedValue({ kind: 'unconfigured' });
    showForm(control);
    const field = await screen.findByLabelText(/Organization activation code/);
    fireEvent.change(field, { target: { value: 'ABCDEF123456' } });
    expect(
      screen.getByText('Enter the full TRO- code followed by 16 letters or digits 2–7.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activate computer' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(control).toHaveBeenCalledOnce();
    fireEvent.change(field, { target: { value: 'tro-abcdefghijklmnop' } });
    expect(screen.getByRole('button', { name: 'Activate computer' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activate computer' }));
    await waitFor(() => {
      expect(control).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'activate', code: 'TRO-ABCDEFGHIJKLMNOP' }),
      );
    });
  });
});
