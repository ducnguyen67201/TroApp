import { MicrophoneLevelCollector } from './MicrophoneLevelCollector.js';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare const sampleRate: number;

declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** Continuous local metering emits scalar levels only and never plays the microphone audio. */
class MicrophonePreviewProcessor extends AudioWorkletProcessor {
  private readonly collector = new MicrophoneLevelCollector(sampleRate);

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) {
      for (const channel of output) {
        channel.fill(0);
      }
    }
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const levelDb of this.collector.collectSamples(samples)) {
        this.port.postMessage({ kind: 'level', levelDb });
      }
    }
    return true;
  }
}

registerProcessor('tro-microphone-preview', MicrophonePreviewProcessor);
