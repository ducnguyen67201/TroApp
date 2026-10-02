import { vi } from 'vitest';
import { AudioFormat } from '#contracts/Transcription.js';

export class TestAudioTrack extends EventTarget implements MediaStreamTrack {
  readonly kind = 'audio';
  readonly id = 'track';
  readonly label = 'USB microphone';
  enabled = true;
  muted = false;
  contentHint = '';
  readyState: MediaStreamTrackState = 'live';
  onended: MediaStreamTrack['onended'] = null;
  onmute: MediaStreamTrack['onmute'] = null;
  onunmute: MediaStreamTrack['onunmute'] = null;
  stop = vi.fn<MediaStreamTrack['stop']>();

  clone(): MediaStreamTrack {
    return this;
  }

  getCapabilities(): MediaTrackCapabilities {
    return {};
  }

  getConstraints(): MediaTrackConstraints {
    return {};
  }

  getSettings(): MediaTrackSettings {
    return { deviceId: 'usb' };
  }

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }
}

export class TestAudioStream extends EventTarget implements MediaStream {
  readonly active = true;
  readonly id = 'stream';
  onaddtrack: MediaStream['onaddtrack'] = null;
  onremovetrack: MediaStream['onremovetrack'] = null;

  constructor(readonly track: TestAudioTrack) {
    super();
  }

  getAudioTracks(): MediaStreamTrack[] {
    return [this.track];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return [];
  }

  getTracks(): MediaStreamTrack[] {
    return [this.track];
  }

  getTrackById(id: string): MediaStreamTrack | null {
    return id === this.track.id ? this.track : null;
  }

  clone(): MediaStream {
    return this;
  }

  addTrack(): void {}

  removeTrack(): void {}
}

interface WorkletTestPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close: () => void;
  postMessage: (message: unknown) => void;
}

interface CaptureSetupOptions {
  sampleRate?: number;
  loadWorklet?: () => Promise<void>;
  resumeContext?: () => Promise<void>;
}

export function stubCapture(
  getUserMedia: MediaDevices['getUserMedia'],
  options: CaptureSetupOptions = {},
) {
  const closeContext = vi.fn<() => Promise<void>>().mockResolvedValue();
  const disconnectWorklet = vi.fn<() => void>();
  const closePort = vi.fn<() => void>();
  const postMessage = vi.fn<(message: unknown) => void>();
  const port: WorkletTestPort = { onmessage: null, close: closePort, postMessage };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = options.sampleRate ?? AudioFormat.SAMPLE_RATE;
      destination = {};
      audioWorklet = { addModule: options.loadWorklet ?? (() => Promise.resolve()) };

      createMediaStreamSource() {
        return { connect: () => {}, disconnect: () => {} };
      }

      resume = options.resumeContext ?? (() => Promise.resolve());
      close = closeContext;
    },
  );
  let triggerProcessorError: () => void = () => {};
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      constructor() {
        triggerProcessorError = () => this.onprocessorerror?.();
      }

      port = port;
      onprocessorerror: (() => void) | null = null;
      disconnect = disconnectWorklet;

      connect(): void {}
    },
  );
  return {
    closeContext,
    disconnectWorklet,
    closePort,
    port,
    postMessage,
    triggerProcessorError: () => {
      triggerProcessorError();
    },
  };
}
