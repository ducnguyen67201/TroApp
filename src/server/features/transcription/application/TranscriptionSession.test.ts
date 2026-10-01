import { describe, expect, it, vi } from 'vitest';
import type { LiveTranscriber, LiveTranscription } from '../ports/LiveTranscriber.js';
import type { TranscriptionAllowance } from '../ports/TranscriptionAllowance.js';
import { TranscriptionEventKind, type TranscriptionEvent } from '#contracts/Transcription.js';
import { TranscriptionSession } from './TranscriptionSession.js';

function createCapture() {
  let receive: ((event: TranscriptionEvent) => void) | null = null;
  const upstream = {
    appendAudio: vi.fn<LiveTranscription['appendAudio']>(),
    finishCapture: vi.fn<() => void>(),
    cancelCapture: vi.fn<() => void>(),
  };
  const provider: LiveTranscriber = {
    openTranscription(_locale, _user, emit) {
      receive = emit;
      return upstream;
    },
  };
  const allowance = {
    releaseUnusedTranscription: vi
      .fn<TranscriptionAllowance['releaseUnusedTranscription']>()
      .mockResolvedValue(),
    reserveTranscription: vi
      .fn<TranscriptionAllowance['reserveTranscription']>()
      .mockResolvedValue(true),
    claimTranscription: vi
      .fn<TranscriptionAllowance['claimTranscription']>()
      .mockResolvedValue(true),
    settleTranscription: vi.fn<TranscriptionAllowance['settleTranscription']>().mockResolvedValue(),
  } satisfies TranscriptionAllowance;
  const emit = vi.fn<(event: TranscriptionEvent) => void>();
  const close = vi.fn<() => void>();
  const capture = new TranscriptionSession(
    'capture',
    'user',
    'vi',
    allowance,
    provider,
    emit,
    close,
  );

  function receiveEvent(event: TranscriptionEvent): void {
    if (!receive) {
      throw new Error('No upstream.');
    }
    receive(event);
  }

  return { capture, upstream, allowance, emit, close, receiveEvent };
}

describe('relay capture', () => {
  it('commits after the declared tail and charges samples once on duplicate close', async () => {
    const harness = createCapture();
    await harness.capture.openTranscription();
    harness.receiveEvent({ kind: TranscriptionEventKind.READY });
    for (let sequence = 0; sequence < 6; sequence += 1) {
      harness.capture.receiveCommand({
        kind: 'audio',
        sequence,
        audio: Buffer.alloc(960).toString('base64'),
      });
    }
    harness.capture.receiveCommand({ kind: 'finish', lastSequence: 5 });
    expect(harness.upstream.finishCapture).toHaveBeenCalledTimes(1);
    harness.receiveEvent({ kind: TranscriptionEventKind.FINAL, text: 'Xin chào' });
    harness.capture.cancelCapture();
    expect(harness.allowance.settleTranscription).toHaveBeenCalledExactlyOnceWith('capture', 2880);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it.each(['sequence', 'odd', 'tail'])('fails closed for an invalid %s', async (invalid) => {
    const harness = createCapture();
    await harness.capture.openTranscription();
    harness.receiveEvent({ kind: TranscriptionEventKind.READY });
    if (invalid === 'tail') {
      harness.capture.receiveCommand({ kind: 'finish', lastSequence: 10 });
    } else {
      harness.capture.receiveCommand({
        kind: 'audio',
        sequence: invalid === 'sequence' ? 1 : 0,
        audio: Buffer.alloc(invalid === 'odd' ? 3 : 960).toString('base64'),
      });
    }
    expect(harness.emit).toHaveBeenCalledWith({ kind: TranscriptionEventKind.FAILED });
    expect(harness.upstream.appendAudio).not.toHaveBeenCalled();
    expect(harness.upstream.finishCapture).not.toHaveBeenCalled();
  });

  it('does not open the provider when a credential is replayed', async () => {
    const harness = createCapture();
    harness.allowance.claimTranscription.mockResolvedValue(false);
    await harness.capture.openTranscription();
    expect(harness.emit).toHaveBeenCalledExactlyOnceWith({ kind: TranscriptionEventKind.FAILED });
    expect(harness.allowance.settleTranscription).not.toHaveBeenCalled();
  });

  it('does not bill the provider for a capture shorter than its commit minimum', async () => {
    const harness = createCapture();
    await harness.capture.openTranscription();
    harness.receiveEvent({ kind: TranscriptionEventKind.READY });
    harness.capture.receiveCommand({ kind: 'finish', lastSequence: -1 });
    expect(harness.emit).toHaveBeenCalledWith({ kind: TranscriptionEventKind.FINAL, text: '' });
    expect(harness.upstream.finishCapture).not.toHaveBeenCalled();
  });
});
