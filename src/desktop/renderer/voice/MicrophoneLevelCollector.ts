const levelUpdatesPerSecond = 10;

/** Keeps only energy totals; each completed window reports one bounded RMS level in dBFS. */
export class MicrophoneLevelCollector {
  private readonly windowSamples: number;
  private count = 0;
  private squares = 0;

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('Microphone sample rate must be positive and finite.');
    }
    /* Rounding up keeps the update rate at or below 10 Hz for every sample rate. */
    this.windowSamples = Math.max(1, Math.ceil(sampleRate / levelUpdatesPerSecond));
  }

  collectSamples(samples: Float32Array): number[] {
    const levels: number[] = [];
    for (const sample of samples) {
      const boundedSample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      this.count += 1;
      this.squares += boundedSample * boundedSample;
      if (this.count === this.windowSamples) {
        levels.push(Math.max(-120, Math.min(0, 10 * Math.log10(this.squares / this.count))));
        this.count = 0;
        this.squares = 0;
      }
    }
    return levels;
  }
}
