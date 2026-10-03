import type { VoiceoverRequest } from '#contracts/Voiceover.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { SpeechProvider } from './VoiceoverPorts.js';

export interface ElevenLabsSettings {
  apiKey: string | undefined;
  modelId: string;
  voiceIds: Readonly<Record<DesktopLocale, string>>;
}

/** Only this backend adapter sees the key; neither provider errors nor text enter logs. */
export class ElevenLabsSpeechProvider implements SpeechProvider {
  constructor(
    private readonly settings: ElevenLabsSettings,
    private readonly request: typeof fetch = fetch,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.settings.apiKey);
  }

  async streamSpeech(
    request: VoiceoverRequest,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!this.settings.apiKey) {
      throw new Error('Speech is unavailable.');
    }
    const voiceId = this.settings.voiceIds[request.locale];
    const response = await this.request(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_24000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.settings.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: request.message.text,
          model_id: this.settings.modelId,
          language_code: request.locale,
        }),
        signal,
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Speech generation failed.');
    }
    return response.body;
  }
}
