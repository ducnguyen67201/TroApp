import type { SpeechCreateParams } from 'openai/resources/audio/speech';
import type { VoiceoverRequest } from '#contracts/Voiceover.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { SpeechProvider } from './VoiceoverPorts.js';

export interface OpenAiSpeechSettings {
  apiKey: string | undefined;
  modelId: string;
  voices: Readonly<Record<DesktopLocale, string>>;
  instructions: Readonly<Record<DesktopLocale, string>>;
}

/** Only this backend adapter sees the key; neither provider errors nor text enter logs. */
export class OpenAiSpeechProvider implements SpeechProvider {
  constructor(
    private readonly settings: OpenAiSpeechSettings,
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
    const voice = this.settings.voices[request.locale];
    const response = await this.request('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.settings.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: request.message.text,
        model: this.settings.modelId,
        voice,
        instructions: this.settings.instructions[request.locale],
        response_format: 'pcm',
        stream_format: 'audio',
      } satisfies SpeechCreateParams),
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Speech generation failed.');
    }
    return response.body;
  }
}
