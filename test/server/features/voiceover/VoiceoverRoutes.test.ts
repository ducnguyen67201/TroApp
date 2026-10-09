import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerVoiceoverRoutes } from '../../../../src/server/features/voiceover/RegisterVoiceoverRoutes.js';
import { OpenAiSpeechProvider } from '../../../../src/server/features/voiceover/OpenAiSpeechProvider.js';
import type {
  SpeechProvider,
  VoiceoverAllowance,
} from '../../../../src/server/features/voiceover/VoiceoverPorts.js';
import { TeachingMessageKind } from '#contracts/TeachingStep.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { VoiceoverConfig } from '../../../../src/server/features/voiceover/VoiceoverConfig.js';
import type { VoiceoverRequest } from '#contracts/Voiceover.js';

function createRequest(): VoiceoverRequest {
  return {
    utteranceId: randomUUID(),
    locale: 'vi',
    message: {
      lessonId: randomUUID(),
      stepId: randomUUID(),
      sequence: 1,
      kind: TeachingMessageKind.INSTRUCTION,
      text: 'Mở Chrome.',
    },
  };
}

it('checks sign-in, input and allowance before streaming speech', async () => {
  const api = Fastify();
  const allowance = {
    reserveVoiceover: vi.fn<VoiceoverAllowance['reserveVoiceover']>().mockResolvedValue(true),
    finishVoiceover: vi.fn<VoiceoverAllowance['finishVoiceover']>().mockResolvedValue(),
  } satisfies VoiceoverAllowance;
  const provider = {
    isAvailable: () => true,
    streamSpeech: vi.fn<SpeechProvider['streamSpeech']>().mockImplementation(() =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array([0, 0, 1, 0]));
            stream.close();
          },
        }),
      ),
    ),
  } satisfies SpeechProvider;
  registerVoiceoverRoutes(
    api,
    (headers) => Promise.resolve(headers.cookie === 'test=session' ? 'user' : null),
    allowance,
    provider,
  );
  try {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/voiceover/stream',
      payload: createRequest(),
    };
    expect((await api.inject(request)).statusCode).toBe(401);
    expect(
      (await api.inject({ ...request, headers: { authorization: 'Bearer model-token' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await api.inject({
          ...request,
          headers: { cookie: 'test=session' },
          payload: { ...request.payload, locale: 'fr' },
        })
      ).statusCode,
    ).toBe(400);
    expect(provider.streamSpeech).not.toHaveBeenCalled();
    const response = await api.inject({ ...request, headers: { cookie: 'test=session' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-tro-audio-format']).toBe('pcm_s16le_24000_mono');
    expect(response.rawPayload).toEqual(Buffer.from([0, 0, 1, 0]));
    expect(allowance.finishVoiceover).toHaveBeenCalledWith('user', request.payload.utteranceId);
    allowance.reserveVoiceover.mockResolvedValue(false);
    expect((await api.inject({ ...request, headers: { cookie: 'test=session' } })).statusCode).toBe(
      429,
    );
    expect(provider.streamSpeech).toHaveBeenCalledOnce();
  } finally {
    await api.close();
  }
});

it('keeps provider settings on the backend and sends the displayed text/locale without retries', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(new Uint8Array([0, 0]))));
  const provider = new OpenAiSpeechProvider(
    {
      apiKey: 'synthetic-provider-key',
      modelId: VoiceoverConfig.MODEL_ID,
      instructions: VoiceoverConfig.INSTRUCTIONS,
      voices: {
        [DesktopLocale.VIETNAMESE]: 'marin',
        [DesktopLocale.ENGLISH]: 'cedar',
      },
    },
    request,
  );
  const controller = new AbortController();
  expect(provider.isAvailable()).toBe(true);
  expect(
    new OpenAiSpeechProvider({
      apiKey: undefined,
      modelId: VoiceoverConfig.MODEL_ID,
      instructions: VoiceoverConfig.INSTRUCTIONS,
      voices: {
        [DesktopLocale.VIETNAMESE]: 'marin',
        [DesktopLocale.ENGLISH]: 'cedar',
      },
    }).isAvailable(),
  ).toBe(false);
  const speech = createRequest();
  for (const locale of [DesktopLocale.VIETNAMESE, DesktopLocale.ENGLISH]) {
    const localizedSpeech = {
      ...speech,
      locale,
      message: { ...speech.message, text: locale === 'vi' ? 'Mở Chrome.' : 'Open Chrome.' },
    };
    const stream = await provider.streamSpeech(localizedSpeech, controller.signal);
    expect(request).toHaveBeenLastCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        signal: controller.signal,
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-provider-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: localizedSpeech.message.text,
          model: VoiceoverConfig.MODEL_ID,
          voice: locale === DesktopLocale.VIETNAMESE ? 'marin' : 'cedar',
          instructions: VoiceoverConfig.INSTRUCTIONS[locale],
          response_format: 'pcm',
          stream_format: 'audio',
        }),
      }),
    );
    await stream.cancel();
  }
  request.mockResolvedValue(new Response('private-provider-error', { status: 500 }));
  await expect(provider.streamSpeech(speech, controller.signal)).rejects.toThrow(
    'Speech generation failed.',
  );
  expect(request).toHaveBeenCalledTimes(3);
});

it('does not dispatch speech without a backend key', async () => {
  const request = vi.fn<typeof fetch>();
  const provider = new OpenAiSpeechProvider(
    {
      apiKey: undefined,
      modelId: VoiceoverConfig.MODEL_ID,
      voices: VoiceoverConfig.VOICES,
      instructions: VoiceoverConfig.INSTRUCTIONS,
    },
    request,
  );
  await expect(
    provider.streamSpeech(createRequest(), new AbortController().signal),
  ).rejects.toThrow('Speech is unavailable.');
  expect(request).not.toHaveBeenCalled();
});

it('preserves cancellation without retrying the paid speech request', async () => {
  const controller = new AbortController();
  const cancellationError = new Error('Speech cancelled.');
  const request = vi.fn<typeof fetch>().mockImplementation(
    (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => {
            reject(cancellationError);
          },
          {
            once: true,
          },
        );
      }),
  );
  const provider = new OpenAiSpeechProvider(
    {
      apiKey: 'synthetic-provider-key',
      modelId: VoiceoverConfig.MODEL_ID,
      voices: VoiceoverConfig.VOICES,
      instructions: VoiceoverConfig.INSTRUCTIONS,
    },
    request,
  );
  const speech = provider.streamSpeech(createRequest(), controller.signal);
  const rejection = expect(speech).rejects.toThrow('Speech cancelled.');
  controller.abort(cancellationError);
  await rejection;
  expect(request).toHaveBeenCalledOnce();
});
