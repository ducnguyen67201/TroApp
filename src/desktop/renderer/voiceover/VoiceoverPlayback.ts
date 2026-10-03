import {
  VoiceoverLimits,
  type VoiceoverPlayback as PlaybackCommand,
} from '#contracts/Voiceover.js';

/** Web Audio resamples buffers from the provider rate to the output device rate. */
export class VoiceoverPlayback {
  private context: AudioContext | null = null;
  private utteranceId: string | null = null;
  private sequence = 0;
  private generation = 0;
  private pendingId: string | null = null;
  private scheduledUntil = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private waits = new Set<(accepted: boolean) => void>();

  async receiveCommand(command: PlaybackCommand): Promise<boolean> {
    if (command.kind === 'stop') {
      if (command.utteranceId === this.utteranceId || command.utteranceId === this.pendingId) {
        await this.stop();
      }
      return true;
    }
    if (command.kind === 'start') {
      const generation = this.generation + 1;
      this.pendingId = command.utteranceId;
      await this.stop(false);
      if (generation !== this.generation) {
        return false;
      }
      this.pendingId = null;
      this.utteranceId = command.utteranceId;
      this.sequence = 0;
      const context = new AudioContext();
      this.context = context;
      await context.resume();
      return this.context === context && context.state === 'running';
    }
    const context = this.context;
    if (
      !context ||
      command.utteranceId !== this.utteranceId ||
      command.sequence !== this.sequence + 1
    ) {
      return false;
    }
    this.sequence = command.sequence;
    if (command.kind === 'end') {
      if (this.sources.size === 0) {
        return true;
      }
      return this.waitUntil(() => this.sources.size === 0);
    }
    const sampleCount = command.pcm.length / 2;
    if (
      Math.max(context.currentTime, this.scheduledUntil) -
        context.currentTime +
        sampleCount / VoiceoverLimits.SAMPLE_RATE >
      VoiceoverLimits.QUEUE_SECONDS
    ) {
      return false;
    }
    const buffer = context.createBuffer(1, sampleCount, VoiceoverLimits.SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    const view = new DataView(command.pcm.buffer, command.pcm.byteOffset, command.pcm.byteLength);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      for (const resume of [...this.waits]) {
        resume(true);
      }
    };
    const startsAt = Math.max(context.currentTime + 0.04, this.scheduledUntil);
    this.scheduledUntil = startsAt + buffer.duration;
    source.start(startsAt);
    if (this.scheduledUntil - context.currentTime <= 1) {
      return true;
    }
    return this.waitUntil(() => this.scheduledUntil - context.currentTime <= 1);
  }

  private waitUntil(isReady: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      const resume = (accepted: boolean): void => {
        if (!accepted || isReady()) {
          this.waits.delete(resume);
          resolve(accepted);
        }
      };
      this.waits.add(resume);
    });
  }

  async stop(clearPending = true): Promise<void> {
    this.generation += 1;
    if (clearPending) {
      this.pendingId = null;
    }
    this.utteranceId = null;
    this.sequence = 0;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    for (const resolve of this.waits) {
      resolve(false);
    }
    this.waits.clear();
    const context = this.context;
    this.context = null;
    this.scheduledUntil = 0;
    await context?.close();
  }
}
