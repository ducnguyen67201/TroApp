import { describe, expect, it } from 'vitest';
import { MicrophoneLevelCollector } from '../../../../src/desktop/renderer/voice/MicrophoneLevelCollector.js';

describe('continuous local input levels', () => {
  it('retains partial windows across chunks and measures each complete window independently', () => {
    const collector = new MicrophoneLevelCollector(100);
    expect(collector.collectSamples(new Float32Array(7).fill(0.1))).toEqual([]);
    const levels = collector.collectSamples(
      new Float32Array([...new Array<number>(3).fill(0.1), ...new Array<number>(10).fill(0.01)]),
    );
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeCloseTo(-20);
    expect(levels[1]).toBeCloseTo(-40);
    expect(collector.collectSamples(new Float32Array())).toEqual([]);
  });

  it('continues past six seconds without exceeding ten updates per second', () => {
    const collector = new MicrophoneLevelCollector(48_000);
    const levels: number[] = [];
    for (let block = 0; block < 3_000; block += 1) {
      levels.push(...collector.collectSamples(new Float32Array(128).fill(0.1)));
    }
    expect(levels).toHaveLength(80);
    expect(levels.every((level) => Math.abs(level + 20) < 0.001)).toBe(true);

    const unevenWindows = new MicrophoneLevelCollector(1_001);
    const unevenLevels = unevenWindows.collectSamples(new Float32Array(2_002));
    expect(unevenLevels).toHaveLength(19);
    expect(unevenLevels.every((level) => level === -120)).toBe(true);
  });

  it('reports silence and saturated audio as finite bounded levels', () => {
    const collector = new MicrophoneLevelCollector(100);
    expect(collector.collectSamples(new Float32Array(10))).toEqual([-120]);
    expect(collector.collectSamples(new Float32Array(10).fill(2))).toEqual([0]);
    expect(collector.collectSamples(new Float32Array(10).fill(-2))).toEqual([0]);
    const levels = collector.collectSamples(
      new Float32Array([NaN, Infinity, -Infinity, 2, -2, 0, 0, 0, 0, 0]),
    );
    expect(levels[0]).toBeCloseTo(10 * Math.log10(2 / 10));
  });

  it.each([0, -1, NaN, Infinity])('rejects the invalid sample rate %s', (sampleRate) => {
    expect(() => new MicrophoneLevelCollector(sampleRate)).toThrow();
  });
});
