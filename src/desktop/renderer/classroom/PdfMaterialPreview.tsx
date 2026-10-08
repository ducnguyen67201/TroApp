import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { ActionIcon, Alert, Button, Group, Loader, Text } from '@mantine/core';
import { IconMinus, IconPlus } from '@tabler/icons-react';
import type { ClassroomTranslate } from './ClassroomLabels.js';
import type { MaterialPdf } from './OpenMaterialPdf.js';

const PdfZoom = { MINIMUM: 50, MAXIMUM: 250, STEP: 25, DEFAULT: 100 } as const;

export function PdfMaterialPreview({
  bytes,
  name,
  t,
}: {
  bytes: Uint8Array;
  name: string;
  t: ClassroomTranslate;
}): ReactElement {
  const scrollArea = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{
    page: HTMLElement;
    fraction: number;
    horizontalCenter: number;
  } | null>(null);
  const [zoom, setZoom] = useState<number>(PdfZoom.DEFAULT);
  const [document, setDocument] = useState<MaterialPdf | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const viewer = { current: true };
    const isCurrent = (): boolean => viewer.current;
    let destroy: (() => void) | undefined;
    const open = async (): Promise<void> => {
      try {
        const { openMaterialPdf } = await import('./OpenMaterialPdf.js');
        if (!isCurrent()) {
          return;
        }
        const loading = openMaterialPdf(bytes);
        destroy = loading.destroy;
        const pdf = await loading.promise;
        if (isCurrent()) {
          setDocument(pdf);
        }
      } catch {
        if (isCurrent()) {
          setFailed(true);
        }
      }
    };
    void open();
    return () => {
      viewer.current = false;
      destroy?.();
    };
  }, [bytes]);

  /** Preserve the current page and position when its rendered dimensions change. */
  function changeZoom(nextZoom: number): void {
    const viewport = scrollArea.current;
    if (viewport && pages.current) {
      const page = Array.from(pages.current.children).find(
        (element) =>
          element instanceof HTMLElement &&
          element.offsetTop + element.offsetHeight > viewport.scrollTop,
      );
      if (page instanceof HTMLElement) {
        scrollAnchor.current = {
          page,
          fraction: Math.max(
            0,
            (viewport.scrollTop - page.offsetTop) / Math.max(1, page.offsetHeight),
          ),
          horizontalCenter:
            (viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(1, viewport.scrollWidth),
        };
      }
    }
    setZoom(Math.min(PdfZoom.MAXIMUM, Math.max(PdfZoom.MINIMUM, nextZoom)));
  }

  useLayoutEffect(() => {
    const viewport = scrollArea.current;
    const anchor = scrollAnchor.current;
    if (viewport && anchor) {
      viewport.scrollTop = anchor.page.offsetTop + anchor.fraction * anchor.page.offsetHeight;
      viewport.scrollLeft =
        anchor.horizontalCenter * viewport.scrollWidth - viewport.clientWidth / 2;
      scrollAnchor.current = null;
    }
  }, [zoom]);

  return (
    <>
      {!document && !failed && (
        <Group role="status" justify="center">
          <Loader size="sm" />
          <Text>{t('Loading PDF…', 'Đang tải PDF…')}</Text>
        </Group>
      )}
      {failed && (
        <Alert role="alert">
          {t(
            'This PDF could not be displayed. It may be damaged or password protected. Download the original to open it.',
            'Không thể hiển thị PDF này. Tệp có thể bị lỗi hoặc có mật khẩu. Tải tệp gốc để mở.',
          )}
        </Alert>
      )}
      {document && (
        <>
          <Group justify="space-between" gap="xs">
            <Text size="sm" c="dimmed">
              {document.pageCount} {t('pages · Scroll to read', 'trang · Cuộn để xem')}
            </Text>
            <Group gap={4} role="group" aria-label={t('Zoom controls', 'Điều chỉnh thu phóng')}>
              <ActionIcon
                variant="default"
                size="md"
                disabled={zoom <= PdfZoom.MINIMUM}
                aria-label={t('Zoom out', 'Thu nhỏ')}
                title={t('Zoom out', 'Thu nhỏ')}
                onClick={() => {
                  changeZoom(zoom - PdfZoom.STEP);
                }}
              >
                <IconMinus size={16} aria-hidden="true" />
              </ActionIcon>
              <Button
                variant="default"
                size="compact-sm"
                aria-label={t('Fit to width', 'Vừa chiều rộng')}
                title={t('Reset zoom to fit width', 'Đặt lại thu phóng vừa chiều rộng')}
                onClick={() => {
                  changeZoom(PdfZoom.DEFAULT);
                }}
              >
                <span aria-live="polite">{zoom}%</span>
              </Button>
              <ActionIcon
                variant="default"
                size="md"
                disabled={zoom >= PdfZoom.MAXIMUM}
                aria-label={t('Zoom in', 'Phóng to')}
                title={t('Zoom in', 'Phóng to')}
                onClick={() => {
                  changeZoom(zoom + PdfZoom.STEP);
                }}
              >
                <IconPlus size={16} aria-hidden="true" />
              </ActionIcon>
            </Group>
          </Group>
          <div
            ref={scrollArea}
            className="material-pdf-preview"
            role="region"
            tabIndex={0}
            aria-label={`${t('PDF preview', 'Xem trước PDF')} ${name}`}
          >
            <div ref={pages} className="material-pdf-pages" style={{ width: `${String(zoom)}%` }}>
              {Array.from({ length: document.pageCount }, (_, index) => (
                <PdfPreviewPage
                  key={index + 1}
                  document={document}
                  page={index + 1}
                  name={name}
                  scrollArea={scrollArea}
                  zoom={zoom}
                  t={t}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Placeholders preserve scrolling; only pages near the viewport retain rendered pixels. */
function PdfPreviewPage({
  document,
  page,
  name,
  scrollArea,
  zoom,
  t,
}: {
  document: MaterialPdf;
  page: number;
  name: string;
  scrollArea: { readonly current: HTMLDivElement | null };
  zoom: number;
  t: ClassroomTranslate;
}): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [nearby, setNearby] = useState(page === 1);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(document.pageAspectRatio);

  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          setNearby(entry.isIntersecting);
        }
      },
      { root: scrollArea.current, rootMargin: '300px 0px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [scrollArea]);

  useEffect(() => {
    const surface = canvas.current;
    if (!nearby || !surface) {
      return;
    }
    let current = true;
    setBusy(true);
    setFailed(false);
    const displayWidth = surface.parentElement?.clientWidth ?? 0;
    const rendering = document.renderPage(
      page,
      surface,
      Math.max(1, Math.round(displayWidth * window.devicePixelRatio)),
    );
    void rendering.promise
      .then(() => {
        if (current) {
          if (surface.width > 0 && surface.height > 0) {
            setAspectRatio(surface.width / surface.height);
          }
          setBusy(false);
        }
      })
      .catch(() => {
        if (current) {
          setBusy(false);
          setFailed(true);
        }
      });
    return () => {
      current = false;
      rendering.cancel();
      surface.width = 0;
      surface.height = 0;
    };
  }, [document, page, nearby, zoom]);

  return (
    <div ref={container} className="material-pdf-page" data-page-number={page}>
      <Text size="xs" c="dimmed" ta="center">
        {t('Page', 'Trang')} {page}
      </Text>
      <div className="material-pdf-page-surface" style={{ aspectRatio }} aria-busy={nearby && busy}>
        <canvas
          ref={canvas}
          width={0}
          height={0}
          role="img"
          hidden={!nearby || busy || failed}
          aria-label={`${name} · ${t('Page', 'Trang')} ${String(page)}`}
        />
        {nearby && busy && (
          <Group role="status" justify="center" className="material-pdf-page-status">
            <Loader size="sm" />
            <Text>{t('Loading page…', 'Đang tải trang…')}</Text>
          </Group>
        )}
        {nearby && failed && (
          <Alert role="alert">
            {t(
              'Could not display this page. Download the original to open it.',
              'Không thể hiển thị trang này. Tải tệp gốc để mở.',
            )}
          </Alert>
        )}
      </div>
    </div>
  );
}
