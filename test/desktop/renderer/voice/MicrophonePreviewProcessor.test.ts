import { afterEach, expect, it, vi } from 'vitest';
import { MicrophoneMeasurementEventSchema } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurements.js';

interface PreviewProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('keeps output silent and emits only scalar levels while continuing without input', async () => {
  const postMessage = vi.fn<(message: unknown) => void>();
  const registrations: { name: string; Processor: new () => PreviewProcessor }[] = [];
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      readonly port = { postMessage };
    },
  );
  vi.stubGlobal('sampleRate', 100);
  vi.stubGlobal('registerProcessor', (name: string, Processor: new () => PreviewProcessor) => {
    registrations.push({ name, Processor });
  });
  await import('../../../../src/desktop/renderer/voice/MicrophonePreviewProcessor.js');
  const registration = registrations[0];
  if (!registration) {
    throw new Error('Preview worklet was not registered.');
  }
  expect(registration.name).toBe('tro-microphone-preview');
  const processor = new registration.Processor();
  const output = new Float32Array(128).fill(1);
  expect(processor.process([], [[output]])).toBe(true);
  expect(output.every((sample) => sample === 0)).toBe(true);
  expect(postMessage).not.toHaveBeenCalled();

  expect(processor.process([[new Float32Array(10).fill(0.1)]], [[output]])).toBe(true);
  expect(postMessage).toHaveBeenCalledOnce();
  const message: unknown = postMessage.mock.calls[0]?.[0];
  const parsed = MicrophoneMeasurementEventSchema.parse(message);
  expect(parsed.kind).toBe('level');
  if (parsed.kind !== 'level') {
    throw new Error('Preview emitted an unexpected measurement event.');
  }
  expect(parsed.levelDb).toBeCloseTo(-20);
  expect(output.every((sample) => sample === 0)).toBe(true);
  expect(processor.process([], [[output]])).toBe(true);
  expect(postMessage).toHaveBeenCalledOnce();
});
