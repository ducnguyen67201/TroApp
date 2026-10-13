import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LessonRenderFailureSchema,
  LessonVisualRenderFailure,
  LessonVisualRenderLimits,
  type LessonRenderVisual,
  type LessonVisualNode,
} from '../contracts/LessonRenderProtocol.js';
import { LessonLimits, type LessonScreen } from '../contracts/LessonVideos.js';
import { LessonVisualCodeError } from './CompileLessonVisual.js';
import { validateLessonVisualFrames } from './ValidateLessonVisualFrames.js';

/**
 * The child has an empty environment and evaluates source only inside QuickJS/WASM.
 * Its stdout is bounded data; a wall-time kill also covers compiler/interpreter failure.
 * This does not rely on Docker privileges, node:vm or Chromium as a source sandbox.
 */
export async function renderLessonVisualFrames(
  visual: LessonRenderVisual,
  screen: LessonScreen,
  durationSeconds: number,
  signal: AbortSignal,
): Promise<LessonVisualNode[]> {
  signal.throwIfAborted();
  if (durationSeconds > LessonVisualRenderLimits.DURATION_SECONDS) {
    throw new LessonVisualCodeError(
      LessonVisualRenderFailure.LIMIT,
      'This scene exceeds the custom animation duration limit.',
    );
  }
  const serialized = await executeVisualChild(
    JSON.stringify({ source: visual.source, screen, durationSeconds }),
    signal,
  );
  const value: unknown = JSON.parse(serialized);
  const failure = LessonRenderFailureSchema.safeParse(value);
  if (failure.success && failure.data.kind === 'code-error') {
    throw new LessonVisualCodeError(failure.data.code, failure.data.diagnostic);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== 'frames' ||
    !('frames' in value)
  ) {
    throw new Error('The visual worker returned an invalid result.');
  }
  return validateLessonVisualFrames(value.frames, Math.ceil(durationSeconds * LessonLimits.FPS));
}

function executeVisualChild(input: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=128',
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./RunLessonVisualWorker.ts', import.meta.url)),
      ],
      { env: {}, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const abort = (): void => {
      child.kill('SIGKILL');
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LessonVisualRenderLimits.EXECUTION_MS + 5000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Buffer)) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > LessonVisualRenderLimits.OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', reject);
    child.stdin.once('error', () => {
      child.kill('SIGKILL');
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Visual rendering was cancelled.'),
        );
      } else if (timedOut || outputExceeded) {
        reject(
          new LessonVisualCodeError(
            LessonVisualRenderFailure.LIMIT,
            'The animation exceeded its execution or output limit.',
          ),
        );
      } else if (code !== 0) {
        reject(new Error('The isolated visual worker is unavailable.'));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    child.stdin.end(input);
  });
}
