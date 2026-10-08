// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import type { MaterialPreviewReply } from '#contracts/ClassroomMaterials.js';
import { MaterialPreviewButton } from '../../../../src/desktop/renderer/classroom/MaterialPreviewButton.js';

const classId = '11111111-1111-4111-8111-111111111111';
const materialId = '22222222-2222-4222-8222-222222222222';
const preview = vi.fn<NonNullable<DesktopBridge['previewClassMaterial']>>();
const download = vi.fn<NonNullable<DesktopBridge['downloadClassMaterial']>>();

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  preview.mockReset();
  download.mockReset().mockResolvedValue(true);
  vi.stubGlobal('tro', {
    previewClassMaterial: preview,
    downloadClassMaterial: download,
  } satisfies Pick<DesktopBridge, 'previewClassMaterial' | 'downloadClassMaterial'>);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(name = 'Lesson.py', id = classId) {
  return createElement(MantineProvider, {
    children: createElement(MaterialPreviewButton, {
      classId: id,
      source: { id: materialId, name, bytes: 100, digest: '', url: null },
      t: (english) => english,
    }),
  });
}

it('fetches an original only on demand and escapes code and markup', async () => {
  const content = '<script>window.bad = true</script>\nprint("Hello")';
  preview.mockResolvedValue({ kind: 'download', name: 'Lesson.py', data: btoa(content) });
  render(view());
  expect(preview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Preview Lesson.py' }));
  const text = await screen.findByText(/window.bad/, { selector: 'pre' });
  expect(text.textContent).toBe(content);
  expect(text.querySelector('script')).toBeNull();
  expect(preview).toHaveBeenCalledExactlyOnceWith(classId, materialId);
  fireEvent.click(screen.getByRole('button', { name: 'Download original' }));
  expect(download).toHaveBeenCalledExactlyOnceWith(classId, materialId);
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  await waitFor(() => {
    expect(screen.queryByText(/window.bad/, { selector: 'pre' })).toBeNull();
  });
});

it('shows denied or malformed originals as failures while keeping the download option', async () => {
  preview.mockResolvedValue({ kind: 'failed', code: 'forbidden' });
  render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Preview Lesson.py' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Could not preview');
  expect(screen.getByRole('button', { name: 'Download original' })).toBeTruthy();
});

it('ignores a late response after closing or switching classes', async () => {
  let finish: (value: MaterialPreviewReply) => void = () => {};
  preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Preview Lesson.py' }));
  await screen.findByText('Loading preview…');
  expect(preview).toHaveBeenCalledOnce();
  preview.mockResolvedValue({ kind: 'download', name: 'Lesson.py', data: btoa('new class') });
  result.rerender(view('Lesson.py', '33333333-3333-4333-8333-333333333333'));
  expect(await screen.findByText('new class', { selector: 'pre' })).toBeTruthy();
  await act(async () => {
    finish({ kind: 'download', name: 'Lesson.py', data: btoa('old private original') });
    await Promise.resolve();
  });
  expect(screen.queryByText('old private original')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
});

it('discards original bytes received after the modal is closed', async () => {
  let finish: (value: MaterialPreviewReply) => void = () => {};
  preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Preview Lesson.py' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Close preview' }));
  await act(async () => {
    finish({ kind: 'download', name: 'Lesson.py', data: btoa('late private original') });
    await Promise.resolve();
  });
  expect(screen.queryByText('late private original')).toBeNull();
});

it('offers an explicit app download for PowerPoint instead of pretending to render slides', async () => {
  render(view('Lesson.pptx'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview Lesson.pptx' }));
  expect(await screen.findByText(/For PowerPoint and Scratch/)).toBeTruthy();
  expect(preview).not.toHaveBeenCalled();
});
