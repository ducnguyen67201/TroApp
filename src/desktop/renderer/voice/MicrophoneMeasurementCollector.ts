import {
  MicrophoneTestPhase,
  quietTestSeconds,
  speechTestSeconds,
} from './MicrophoneTestTiming.js';
import type { MicrophoneMeasurementEvent } from './MicrophoneMeasurements.js';

interface SampleTotals {
  count: number;
  squares: number;
  clipped: number;
}

function convertToDecibels(totals: SampleTotals): number {
  return Math.max(-120, Math.min(0, 10 * Math.log10(totals.squares / Math.max(1, totals.count))));
}

/** Accumulates scalar statistics only. Phase boundaries follow sample count, not UI timers. */
export class MicrophoneMeasurementCollector {
  private readonly quiet: SampleTotals = { count: 0, squares: 0, clipped: 0 };
  private readonly speech: SampleTotals = { count: 0, squares: 0, clipped: 0 };
  private count = 0;
  private previousSecond = -1;

  constructor(private readonly sampleRate: number) {}

  collectSamples(samples: Float32Array): MicrophoneMeasurementEvent[] {
    const events: MicrophoneMeasurementEvent[] = [];
    const totalSamples = this.sampleRate * (quietTestSeconds + speechTestSeconds);
    if (this.count >= totalSamples) {
      return events;
    }
    for (const sample of samples) {
      if (this.count >= totalSamples) {
        break;
      }
      const totals = this.count < this.sampleRate * quietTestSeconds ? this.quiet : this.speech;
      const boundedSample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      totals.count += 1;
      totals.squares += boundedSample * boundedSample;
      if (Math.abs(boundedSample) >= 0.99) {
        totals.clipped += 1;
      }
      const second = Math.floor(this.count / this.sampleRate);
      if (second !== this.previousSecond) {
        this.previousSecond = second;
        events.push({
          kind: 'progress',
          phase:
            second < quietTestSeconds ? MicrophoneTestPhase.QUIET : MicrophoneTestPhase.SPEAKING,
          secondsRemaining:
            second < quietTestSeconds
              ? quietTestSeconds - second
              : quietTestSeconds + speechTestSeconds - second,
        });
      }
      this.count += 1;
    }
    if (this.count === totalSamples) {
      events.push({
        kind: 'result',
        measurement: {
          version: 1,
          noiseDb: convertToDecibels(this.quiet),
          speechDb: convertToDecibels(this.speech),
          clippedFraction: this.speech.clipped / Math.max(1, this.speech.count),
        },
      });
    }
    return events;
  }
}
