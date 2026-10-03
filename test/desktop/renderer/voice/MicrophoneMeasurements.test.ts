import { MicrophoneMeasurementCollector } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurementCollector.js';
import { describe, expect, it } from 'vitest';
import { MicrophoneMeasurementEventSchema } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurements.js';

describe('local microphone measurements', () => {
  it('separates quiet and speech at exact sample boundaries, reports clipping, then stops', () => {
    const collector = new MicrophoneMeasurementCollector(10);
    expect(collector.collectSamples(new Float32Array(15).fill(0.01))).toEqual([
      { kind: 'progress', phase: 'quiet', secondsRemaining: 2 },
      { kind: 'progress', phase: 'quiet', secondsRemaining: 1 },
    ]);
    const events = collector.collectSamples(
      new Float32Array([
        ...new Array<number>(5).fill(0.01),
        ...new Array<number>(30).fill(0.1),
        ...new Array<number>(10).fill(1),
      ]),
    );
    const result = events.find((event) => event.kind === 'result');
    expect(result?.measurement.noiseDb).toBeCloseTo(-40);
    expect(result?.measurement.speechDb).toBeCloseTo(10 * Math.log10(10.3 / 40));
    expect(result?.measurement.clippedFraction).toBe(0.25);
    expect(
      events.filter((event) => event.kind === 'progress').map((event) => event.secondsRemaining),
    ).toEqual([4, 3, 2, 1]);
    expect(collector.collectSamples(new Float32Array(100).fill(1))).toEqual([]);
  });

  it('reports finite floor levels for silence and never mistakes silence for quality', () => {
    const events = new MicrophoneMeasurementCollector(1).collectSamples(new Float32Array(6));
    expect(events.at(-1)).toEqual({
      kind: 'result',
      measurement: { version: 1, noiseDb: -120, speechDb: -120, clippedFraction: 0 },
    });
  });

  it('rejects raw samples, non-finite or out-of-range results at the worklet boundary', () => {
    expect(MicrophoneMeasurementEventSchema.safeParse(new Float32Array(128)).success).toBe(false);
    expect(
      MicrophoneMeasurementEventSchema.safeParse({
        kind: 'result',
        measurement: { version: 1, noiseDb: -30, speechDb: -10, clippedFraction: 2 },
      }).success,
    ).toBe(false);
    expect(
      MicrophoneMeasurementEventSchema.safeParse({
        kind: 'progress',
        phase: 'speaking',
        secondsRemaining: NaN,
      }).success,
    ).toBe(false);
  });
});
