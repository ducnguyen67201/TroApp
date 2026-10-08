// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  MaterialPdf,
  openMaterialPdf,
} from '../../../../src/desktop/renderer/classroom/OpenMaterialPdf.js';
import { PdfMaterialPreview } from '../../../../src/desktop/renderer/classroom/PdfMaterialPreview.js';

const pdf = vi.hoisted(() => ({
  open: vi.fn<typeof openMaterialPdf>(),
  renderPage: vi.fn<MaterialPdf['renderPage']>(),
  destroy: vi.fn<() => void>(),
  cancel: vi.fn<() => void>(),
}));

vi.mock('../../../../src/desktop/renderer/classroom/OpenMaterialPdf.js', () => ({
  openMaterialPdf: pdf.open,
}));

const observers: PreviewObserver[] = [];

class PreviewObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];
  target: Element | null = null;
  disconnect = vi.fn<() => void>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? '';
    observers.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  setVisible(visible: boolean): void {
    if (!this.target) {
      throw new Error('Missing observed page');
    }
    this.callback(
      [
        {
          target: this.target,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
          time: 0,
          rootBounds: new DOMRect(0, 0, 800, 600),
          boundingClientRect: this.target.getBoundingClientRect(),
          intersectionRect: this.target.getBoundingClientRect(),
        },
      ],
      this,
    );
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', PreviewObserver);
  pdf.open.mockReset().mockReturnValue({
    promise: Promise.resolve({
      pageCount: 10,
      pageAspectRatio: 16 / 9,
      renderPage: pdf.renderPage,
    }),
    destroy: pdf.destroy,
  });
  pdf.renderPage.mockReset().mockImplementation((_page, canvas) => {
    canvas.width = 900;
    canvas.height = 506;
    return { promise: Promise.resolve(), cancel: pdf.cancel };
  });
  pdf.destroy.mockClear();
  pdf.cancel.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPdf() {
  return render(
    createElement(MantineProvider, {
      children: createElement(PdfMaterialPreview, {
        bytes: new Uint8Array([1]),
        name: 'Lesson.pdf',
        t: (english) => english,
      }),
    }),
  );
}

function observerForPage(page: number): PreviewObserver {
  const observer = observers.find(
    (candidate) => candidate.target?.getAttribute('data-page-number') === String(page),
  );
  if (!observer) {
    throw new Error('Missing page observer');
  }
  return observer;
}

it('offers a scrollable document and renders only nearby pages, releasing pages that leave view', async () => {
  const { unmount } = renderPdf();
  await screen.findByRole('img', { name: 'Lesson.pdf · Page 1' });
  const region = screen.getByRole('region', { name: 'PDF preview Lesson.pdf' });
  expect(region.tabIndex).toBe(0);
  expect(screen.getByText('10 pages · Scroll to read')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  expect(observers).toHaveLength(10);
  expect(observerForPage(2).root).toBe(region);
  expect(observerForPage(2).rootMargin).toBe('300px 0px');
  expect(pdf.renderPage).toHaveBeenCalledExactlyOnceWith(
    1,
    expect.any(HTMLCanvasElement),
    expect.any(Number),
  );
  act(() => {
    observerForPage(2).setVisible(true);
  });
  await screen.findByRole('img', { name: 'Lesson.pdf · Page 2' });
  expect(pdf.renderPage).toHaveBeenCalledTimes(2);
  const firstCanvas = screen.getByRole('img', { name: 'Lesson.pdf · Page 1' });
  act(() => {
    observerForPage(1).setVisible(false);
  });
  expect(firstCanvas).toHaveProperty('width', 0);
  expect(firstCanvas).toHaveProperty('height', 0);
  expect(screen.queryByRole('img', { name: 'Lesson.pdf · Page 1' })).toBeNull();
  expect(pdf.cancel).toHaveBeenCalledOnce();
  act(() => {
    observerForPage(1).setVisible(true);
  });
  await screen.findByRole('img', { name: 'Lesson.pdf · Page 1' });
  expect(pdf.renderPage).toHaveBeenCalledTimes(3);
  unmount();
  expect(pdf.destroy).toHaveBeenCalledOnce();
  expect(pdf.cancel).toHaveBeenCalledTimes(3);
  expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
});

it('cancels a pending page when scrolled away and ignores its late completion', async () => {
  let finish: () => void = () => {};
  pdf.renderPage.mockReturnValueOnce({
    promise: new Promise((resolve) => {
      finish = resolve;
    }),
    cancel: pdf.cancel,
  });
  renderPdf();
  await waitFor(() => {
    expect(observers).toHaveLength(10);
  });
  act(() => {
    observerForPage(1).setVisible(false);
  });
  expect(pdf.cancel).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(screen.queryByRole('img', { name: 'Lesson.pdf · Page 1' })).toBeNull();
});

it('shows a PDF failure without exposing parser internals', async () => {
  pdf.open.mockReturnValueOnce({
    promise: Promise.reject(new Error('private parser details')),
    destroy: pdf.destroy,
  });
  renderPdf();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'This PDF could not be displayed',
  );
  expect(screen.queryByText(/private parser details/)).toBeNull();
});

it('zooms the page stack within bounds, repaints nearby pages and resets to fit width', async () => {
  const { container } = renderPdf();
  await screen.findByRole('img', { name: 'Lesson.pdf · Page 1' });
  const stack = container.querySelector('.material-pdf-pages');
  expect(stack).toHaveProperty('style.width', '100%');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByText('125%')).toBeTruthy();
  expect(stack?.getAttribute('style')).toContain('width: 125%');
  await screen.findByRole('img', { name: 'Lesson.pdf · Page 1' });
  expect(pdf.renderPage).toHaveBeenCalledTimes(2);
  expect(pdf.cancel).toHaveBeenCalledOnce();
  for (let count = 0; count < 8; count += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  }
  expect(screen.getByText('250%')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Fit to width' }));
  expect(screen.getByText('100%')).toBeTruthy();
  for (let count = 0; count < 4; count += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  }
  expect(screen.getByText('50%')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveProperty('disabled', true);
  expect(pdf.open).toHaveBeenCalledOnce();
});
