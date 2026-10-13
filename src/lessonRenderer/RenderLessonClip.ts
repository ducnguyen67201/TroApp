import { renderMedia, selectComposition, makeCancelSignal } from '@remotion/renderer';
import type { LessonRenderProps } from '../contracts/LessonRenderProtocol.js';

/** Chromium runs only the maintained bundle; optional visual frames are validated SVG data. */
export async function renderLessonClip(
  bundle: string,
  output: string,
  props: LessonRenderProps,
  signal: AbortSignal,
  browserExecutable?: string,
): Promise<void> {
  const { cancelSignal, cancel } = makeCancelSignal();
  signal.throwIfAborted();
  const abort = (): void => {
    cancel();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const composition = await selectComposition({
      serveUrl: bundle,
      id: 'LessonScreen',
      inputProps: props,
      ...(browserExecutable ? { browserExecutable } : {}),
      timeoutInMilliseconds: 30000,
    });
    signal.throwIfAborted();
    await renderMedia({
      composition,
      serveUrl: bundle,
      inputProps: props,
      codec: 'h264',
      audioCodec: 'aac',
      outputLocation: output,
      concurrency: 1,
      enforceAudioTrack: true,
      pixelFormat: 'yuv420p',
      cancelSignal,
      ...(browserExecutable ? { browserExecutable } : {}),
      chromiumOptions: { gl: 'swangle' },
      timeoutInMilliseconds: 30000,
      logLevel: 'error',
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
