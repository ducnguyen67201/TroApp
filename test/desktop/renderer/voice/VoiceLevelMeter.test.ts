import { describe, expect, it } from 'vitest';
import {
  VoiceLevelMeter,
  readVoiceLevel,
} from '../../../../src/desktop/renderer/voice/VoiceLevelMeter.js';
import { VoiceMeterSchema, type VoiceMeter } from '#contracts/CompanionHud.js';

function createPcm(sample: number): Uint8Array {
  const pcm = new Uint8Array(960);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < 480; index += 1) {
    view.setInt16(index * 2, sample, true);
  }
  return pcm;
}

describe('local audio meter', () => {
  it('reads PCM16 little endian including byte offsets, silence and saturation', () => {
    expect(readVoiceLevel(createPcm(0))).toBe(0);
    expect(readVoiceLevel(createPcm(4096))).toBeCloseTo(0.5);
    expect(readVoiceLevel(createPcm(-32768))).toBe(1);
    const prefixed = new Uint8Array(962);
    prefixed.set(createPcm(4096), 2);
    expect(readVoiceLevel(prefixed.subarray(2))).toBeCloseTo(0.5);
  });
  it('limits to 20Hz and stops on release without blocking audio on a failed send', () => {
    let now = 0;
    const sent: VoiceMeter[] = [];
    const meter = new VoiceLevelMeter(
      '11111111-1111-4111-8111-111111111111',
      (value) => {
        sent.push(value);
      },
      () => now,
    );
    for (let index = 0; index < 50; index += 1) {
      now = index * 20;
      meter.appendFrame(createPcm(4096));
    }
    expect(sent.length).toBeLessThanOrEqual(20);
    meter.stop();
    now = 2000;
    meter.appendFrame(createPcm(1));
    expect(sent.at(-1)?.sequence).toBe(sent.length - 1);
    const broken = new VoiceLevelMeter('11111111-1111-4111-8111-111111111111', () => {
      throw new Error('offline');
    });
    expect(() => {
      broken.appendFrame(createPcm(1));
    }).not.toThrow();
    expect(VoiceMeterSchema.safeParse({ captureId: 'wrong', sequence: 0, level: 1 }).success).toBe(
      false,
    );
    expect(
      VoiceMeterSchema.safeParse({ captureId: sent[0]?.captureId, sequence: 0, level: NaN })
        .success,
    ).toBe(false);
  });
});
