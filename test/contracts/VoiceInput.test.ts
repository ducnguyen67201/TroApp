import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VoiceAudioFrameSchema, VoiceCommandSchema } from '../../src/contracts/VoiceInput.js';
import { TranscriptionCommandSchema } from '../../src/contracts/Transcription.js';
import { AgentTaskMode } from '../../src/contracts/CursorCompanion.js';

describe('voice boundary validation', () => {
  it('carries teaching mode and rejects unsupported modes', () => {
    const command = {
      kind: 'prepare',
      captureId: randomUUID(),
      locale: 'vi',
      mode: AgentTaskMode.TEACH,
    };
    expect(VoiceCommandSchema.parse(command)).toEqual(command);
    expect(VoiceCommandSchema.safeParse({ ...command, mode: 'unknown' }).success).toBe(false);
  });

  it('requires the existing supported locale and denies arbitrary provider configuration', () => {
    const captureId = randomUUID();
    expect(VoiceCommandSchema.safeParse({ kind: 'prepare', captureId, locale: 'vi' }).success).toBe(
      true,
    );
    expect(VoiceCommandSchema.safeParse({ kind: 'prepare', captureId }).success).toBe(false);
    expect(VoiceCommandSchema.safeParse({ kind: 'prepare', captureId, locale: 'de' }).success).toBe(
      false,
    );
    expect(
      VoiceCommandSchema.safeParse({
        kind: 'prepare',
        captureId,
        locale: 'en',
        url: 'https://foreign.test',
      }).success,
    ).toBe(false);
  });

  it('bounds PCM frames and sequence numbers and validates base64', () => {
    const captureId = randomUUID();
    expect(
      VoiceAudioFrameSchema.safeParse({ captureId, sequence: 0, pcm: new Uint8Array(64) }).success,
    ).toBe(true);
    for (const length of [0, 3, 962]) {
      expect(
        VoiceAudioFrameSchema.safeParse({ captureId, sequence: 0, pcm: new Uint8Array(length) })
          .success,
      ).toBe(false);
    }
    expect(
      TranscriptionCommandSchema.safeParse({ kind: 'audio', sequence: -1, audio: 'AAAA' }).success,
    ).toBe(false);
    expect(
      TranscriptionCommandSchema.safeParse({ kind: 'audio', sequence: 0, audio: 'not base64!' })
        .success,
    ).toBe(false);
  });
});
