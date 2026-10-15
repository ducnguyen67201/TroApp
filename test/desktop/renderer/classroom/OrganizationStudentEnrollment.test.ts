// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { OrganizationStudentEnrollment } from '../../../../src/desktop/renderer/classroom/OrganizationStudentEnrollment.js';

afterEach(cleanup);

it.each(['001Ab', 'https://school.example.test/card?id=001Ab', 'BEGIN:VCARD\nFN:Minh\nEND:VCARD'])(
  'enrolls exact QR contents without using a computer code: %s',
  async (externalId) => {
    const classId = '11111111-1111-4111-8111-111111111111';
    const control = vi
      .fn<NonNullable<DesktopBridge['controlClassroom']>>()
      .mockResolvedValue({ kind: 'ok' });
    Object.defineProperty(window, 'tro', {
      configurable: true,
      value: { controlClassroom: control },
    });
    render(
      createElement(MantineProvider, {
        env: 'test',
        children: createElement(OrganizationStudentEnrollment, {
          classId,
          disabled: false,
          t: (english: string) => english,
        }),
      }),
    );
    expect(screen.queryByLabelText(/activation code/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/School student ID/), { target: { value: externalId } });
    fireEvent.click(screen.getByRole('button', { name: 'Enroll QR student' }));
    expect(await screen.findByText('Student added to this class.')).toBeTruthy();
    expect(control).toHaveBeenCalledExactlyOnceWith({
      kind: 'enroll-qr-student',
      classId,
      externalId,
    });
  },
);
