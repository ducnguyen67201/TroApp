import { MicrophoneMeasurementCollector } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurementCollector.js';
import { describe, expect, it } from 'vitest';
import { MicrophoneMeasurementEventSchema } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurements.js';

describe('local microphone measurements', () => {
  it('separates quiet and speech at exact sample boundaries, reports clipping, then stops', () => {
    const collector = new MicrophoneMeasurementCollector(10);
    const initialEvents = collector.collectSamples(new Float32Array(15).fill(0.01));
    expect(initialEvents.filter((event) => event.kind === 'progress')).toEqual([
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

  it('emits bounded short-window RMS levels at 10 Hz across sample batches', () => {
    const collector = new MicrophoneMeasurementCollector(1_000);
    const firstEvents = collector.collectSamples(new Float32Array(49).fill(0.1));
    expect(firstEvents).toEqual([{ kind: 'progress', phase: 'quiet', secondsRemaining: 2 }]);
    const secondEvents = collector.collectSamples(new Float32Array(51).fill(0.1));
    expect(secondEvents).toHaveLength(1);
    const level = secondEvents[0];
    expect(level?.kind).toBe('level');
    if (level?.kind !== 'level') {
      throw new Error('Missing level event');
    }
    expect(level.levelDb).toBeCloseTo(-20);
    expect(collector.collectSamples(new Float32Array(100))).toEqual([
      { kind: 'level', levelDb: -120 },
    ]);
    expect(collector.collectSamples(new Float32Array(100).fill(1))).toEqual([
      { kind: 'level', levelDb: 0 },
    ]);

    const finalEvents = collector.collectSamples(new Float32Array(5_700));
    expect(finalEvents.filter((event) => event.kind === 'level')).toHaveLength(57);
    expect(finalEvents.at(-1)?.kind).toBe('result');
    for (const event of [...firstEvents, ...secondEvents, ...finalEvents]) {
      expect(MicrophoneMeasurementEventSchema.safeParse(event).success).toBe(true);
    }
    expect(collector.collectSamples(new Float32Array(1_000).fill(1))).toEqual([]);
  });

  it('bounds non-finite and over-range samples before calculating live levels', () => {
    const events = new MicrophoneMeasurementCollector(10).collectSamples(
      new Float32Array([NaN, Infinity, -Infinity, 2, -2]),
    );
    expect(events.filter((event) => event.kind === 'level')).toEqual([
      { kind: 'level', levelDb: -120 },
      { kind: 'level', levelDb: -120 },
      { kind: 'level', levelDb: -120 },
      { kind: 'level', levelDb: 0 },
      { kind: 'level', levelDb: 0 },
    ]);
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

  it.each([NaN, Infinity, -Infinity, -121, 1])('rejects invalid live level %s', (levelDb) => {
    expect(MicrophoneMeasurementEventSchema.safeParse({ kind: 'level', levelDb }).success).toBe(
      false,
    );
  });

  it('rejects live levels carrying raw samples or other fields', () => {
    expect(
      MicrophoneMeasurementEventSchema.safeParse({
        kind: 'level',
        levelDb: -30,
        samples: new Float32Array(128),
      }).success,
    ).toBe(false);
  });
});
