import { expect, it, vi } from 'vitest';

interface TestProcessor {
  process(inputs: Float32Array[][]): boolean;
}

function isTestProcessor(value: unknown): value is TestProcessor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'process' in value &&
    typeof value.process === 'function'
  );
}

it('encodes clipped little-endian samples and emits the short tail before flush acknowledgment', async () => {
  const output: unknown[] = [];
  const port: {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(value: unknown): void;
  } = {
    onmessage: null,
    postMessage(value) {
      output.push(value);
    },
  };
  let instance: unknown;
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      readonly port = port;
    },
  );
  vi.stubGlobal('registerProcessor', (_name: string, constructor: unknown) => {
    if (typeof constructor !== 'function') {
      throw new Error('Invalid processor.');
    }
    instance = Reflect.construct(constructor, []);
  });
  try {
    await import('./VoiceAudioProcessor.js');
    if (!isTestProcessor(instance)) {
      throw new Error('Missing processor.');
    }
    instance.process([[new Float32Array(480)]]);
    instance.process([[new Float32Array([-2, -0.5, 0, 0.5, 2])]]);
    port.onmessage?.(new MessageEvent('message', { data: 'flush' }));
    expect(output).toHaveLength(3);
    const complete = output[0];
    const tail = output[1];
    if (!(complete instanceof Uint8Array) || !(tail instanceof Uint8Array)) {
      throw new Error('Invalid PCM output.');
    }
    expect(complete.byteLength).toBe(960);
    expect(tail.byteLength).toBe(10);
    expect([...tail]).toEqual([0, 128, 0, 192, 0, 0, 0, 64, 255, 127]);
    expect(output[2]).toBe('flushed');
    expect(instance.process([[new Float32Array(480)]])).toBe(false);
    expect(output).toHaveLength(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
