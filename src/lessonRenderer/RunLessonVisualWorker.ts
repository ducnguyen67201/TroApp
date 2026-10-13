import { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
import { z } from 'zod';
import {
  LessonVisualRenderFailure,
  LessonVisualRenderLimits,
} from '../contracts/LessonRenderProtocol.js';
import { LessonLimits, LessonScreenSchema } from '../contracts/LessonVideos.js';
import { compileLessonVisual, LessonVisualCodeError } from './CompileLessonVisual.js';
import { lessonVisualKernel } from './LessonVisualKernel.js';
import { validateLessonVisualFrames } from './ValidateLessonVisualFrames.js';

const requestSchema = z.strictObject({
  source: z.string().min(1).max(LessonVisualRenderLimits.SOURCE_CHARACTERS),
  screen: LessonScreenSchema,
  durationSeconds: z.number().min(1).max(LessonVisualRenderLimits.DURATION_SECONDS),
});

/** Trusted child entrypoint. Generated code is evaluated exclusively in the WASM guest. */
async function runVisualWorker(): Promise<void> {
  const chunks: Buffer[] = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Buffer)) {
      throw new Error('Invalid worker input.');
    }
    inputBytes += chunk.byteLength;
    if (inputBytes > LessonVisualRenderLimits.SOURCE_CHARACTERS * 6 + 16000) {
      throw new LessonVisualCodeError(
        LessonVisualRenderFailure.LIMIT,
        'The scene input exceeds the limit.',
      );
    }
    chunks.push(chunk);
  }
  const request = Buffer.concat(chunks).toString('utf8');
  const value: unknown = JSON.parse(request);
  const input = requestSchema.parse(value);
  const compiled = compileLessonVisual(input.source);
  const durationInFrames = Math.ceil(input.durationSeconds * LessonLimits.FPS);
  /* QuickJS 0.32.0 allocation accounting is insufficient on its own (#271).
     The WASM maximum is an independent byte ceiling enforced by WebAssembly. */
  const memory = new WebAssembly.Memory({
    initial: LessonVisualRenderLimits.MEMORY_BYTES / 65536,
    maximum: LessonVisualRenderLimits.WASM_MEMORY_BYTES / 65536,
  });
  const module = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(LessonVisualRenderLimits.MEMORY_BYTES);
  runtime.setMaxStackSize(LessonVisualRenderLimits.STACK_BYTES);
  const deadline = Date.now() + LessonVisualRenderLimits.EXECUTION_MS;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    const props = {
      frame: 0,
      fps: LessonLimits.FPS,
      durationInFrames,
      width: LessonVisualRenderLimits.WIDTH,
      height: LessonVisualRenderLimits.HEIGHT,
      screen: input.screen,
    };
    const code = `${lessonVisualKernel}(${JSON.stringify(compiled)}, ${JSON.stringify(props)}, ${JSON.stringify({ frameCharacters: LessonVisualRenderLimits.FRAME_CHARACTERS, outputCharacters: LessonVisualRenderLimits.OUTPUT_BYTES / 3 })})`;
    const result = (() => {
      try {
        return context.evalCode(code, 'Scene.js');
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) {
          throw new LessonVisualCodeError(
            LessonVisualRenderFailure.LIMIT,
            'The scene exceeded the isolated runtime memory limit.',
          );
        }
        throw error;
      }
    })();
    if (result.error) {
      const error: unknown = context.dump(result.error);
      result.error.dispose();
      throw new LessonVisualCodeError(
        Date.now() >= deadline
          ? LessonVisualRenderFailure.LIMIT
          : LessonVisualRenderFailure.EXECUTION,
        readGuestDiagnostic(error),
      );
    }
    const serialized: unknown = context.dump(result.value);
    result.value.dispose();
    if (
      typeof serialized !== 'string' ||
      Buffer.byteLength(serialized) > LessonVisualRenderLimits.OUTPUT_BYTES
    ) {
      throw new LessonVisualCodeError(
        LessonVisualRenderFailure.LIMIT,
        'The animation output exceeds the limit.',
      );
    }
    const frames: unknown = JSON.parse(serialized);
    const validated = validateLessonVisualFrames(frames, durationInFrames);
    process.stdout.write(JSON.stringify({ kind: 'frames', frames: validated }));
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

function readGuestDiagnostic(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  ) {
    return value.message;
  }
  return 'The scene could not execute. Use a synchronous SVG component and the supported API.';
}

void runVisualWorker().catch((error: unknown) => {
  if (error instanceof LessonVisualCodeError) {
    process.stdout.write(JSON.stringify(error.failure));
    return;
  }
  process.exitCode = 1;
});
