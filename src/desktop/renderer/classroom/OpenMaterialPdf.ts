import { getDocument, PDFWorker, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

export interface MaterialPdf {
  pageCount: number;
  pageAspectRatio: number;
  renderPage: (
    pageNumber: number,
    canvas: HTMLCanvasElement,
    targetWidth: number,
  ) => {
    promise: Promise<void>;
    cancel: () => void;
  };
}

/** Imported only after opening a PDF. One worker; the viewer releases offscreen page canvases. */
export function openMaterialPdf(bytes: Uint8Array): {
  promise: Promise<MaterialPdf>;
  destroy: () => void;
} {
  const port = new PdfWorker();
  const worker = PDFWorker.create({ port });
  const task = getDocument({
    data: bytes,
    worker,
    // Draw embedded glyphs without dynamic font URLs; all content stays local.
    disableFontFace: true,
    useWorkerFetch: false,
    useWasm: false,
    canvasMaxAreaInBytes: 16_000_000,
    verbosity: 0,
  });
  return {
    promise: task.promise.then(async (document) => {
      const page = await document.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      page.cleanup();
      return {
        pageCount: document.numPages,
        pageAspectRatio: viewport.width / viewport.height,
        renderPage: (pageNumber, canvas, targetWidth) =>
          renderMaterialPdfPage(document, pageNumber, canvas, targetWidth),
      };
    }),
    destroy: () => {
      void task
        .destroy()
        .catch(() => {})
        .finally(() => {
          worker.destroy();
          port.terminate();
        });
    },
  };
}

function renderMaterialPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  targetWidth: number,
): {
  promise: Promise<void>;
  cancel: () => void;
} {
  const rendering: { canceled: boolean; task: RenderTask | null } = { canceled: false, task: null };
  return {
    promise: (async () => {
      const page = await document.getPage(pageNumber);
      try {
        if (rendering.canceled) {
          return;
        }
        const original = page.getViewport({ scale: 1 });
        // Repaint at the requested zoom while keeping every canvas below four million pixels.
        const scale = Math.min(
          targetWidth / original.width,
          2400 / original.width,
          3600 / original.height,
          Math.sqrt(4_000_000 / (original.width * original.height)),
        );
        const viewport = page.getViewport({ scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        rendering.task = page.render({ canvas, viewport });
        await rendering.task.promise;
      } finally {
        page.cleanup();
      }
    })(),
    cancel: () => {
      rendering.canceled = true;
      rendering.task?.cancel();
    },
  };
}
