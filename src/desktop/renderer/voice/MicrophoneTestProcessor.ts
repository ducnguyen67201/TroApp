import { MicrophoneMeasurementCollector } from './MicrophoneMeasurementCollector.js';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare const sampleRate: number;

declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** No PCM crosses the worklet port. Its outputs remain silent to avoid feedback. */
class MicrophoneTestProcessor extends AudioWorkletProcessor {
  private readonly collector = new MicrophoneMeasurementCollector(sampleRate);
  private isComplete = false;

  process(inputs: Float32Array[][]): boolean {
    if (this.isComplete) {
      return false;
    }
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const event of this.collector.collectSamples(samples)) {
        this.port.postMessage(event);
        if (event.kind === 'result') {
          this.isComplete = true;
        }
      }
    }
    return !this.isComplete;
  }
}

registerProcessor('tro-microphone-test', MicrophoneTestProcessor);
