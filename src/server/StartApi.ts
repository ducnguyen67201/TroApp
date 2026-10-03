import { ElevenLabsSpeechProvider } from './features/voiceover/ElevenLabsSpeechProvider.js';
import { VoiceoverConfig } from './features/voiceover/VoiceoverConfig.js';
import { registerVoiceoverRoutes } from './features/voiceover/RegisterVoiceoverRoutes.js';
import { createPrismaVoiceoverAllowance } from './persistence/PrismaVoiceoverAllowance.js';
import { TranscriptionConfig } from './features/transcription/TranscriptionConfig.js';
import { registerTranscriptionRoutes } from './features/transcription/infrastructure/RegisterTranscriptionRoutes.js';
import { OpenAiLiveTranscriber } from './features/transcription/infrastructure/OpenAiLiveTranscriber.js';
import { createPrismaTranscriptionAllowance } from './persistence/PrismaTranscriptionAllowance.js';
import { createApi } from './CreateApi.js';
import { createAuthDatabase } from './persistence/AuthDatabase.js';
import { registerAuthRoutes } from './auth/RegisterAuthRoutes.js';
import { registerModelGateway } from './auth/RegisterModelGateway.js';
import { readServerEnv } from './Env.js';
import { createServerLogger } from './Logger.js';
import { createPrismaDatabaseStatus } from './persistence/PrismaDatabaseStatus.js';

async function startApi(): Promise<void> {
  const environment = readServerEnv(process.env);
  const logger = createServerLogger(environment.APP_ENV);
  const database = createPrismaDatabaseStatus(environment.DATABASE_URL, logger);
  const authentication = createAuthDatabase(environment);
  const api = createApi(database);
  const voiceoverAllowance = createPrismaVoiceoverAllowance(environment.DATABASE_URL, {
    dailyCharacters: environment.VOICEOVER_DAILY_CHARACTERS,
    globalDailyCharacters: environment.VOICEOVER_GLOBAL_DAILY_CHARACTERS,
    globalStreams: environment.VOICEOVER_GLOBAL_STREAMS,
  });
  registerVoiceoverRoutes(
    api,
    authentication.readSignedInUserId,
    voiceoverAllowance,
    new ElevenLabsSpeechProvider({
      apiKey: environment.ELEVENLABS_API_KEY,
      modelId: environment.ELEVENLABS_MODEL_ID,
      voiceIds: VoiceoverConfig.VOICE_IDS,
    }),
  );
  const transcriptionAllowance = createPrismaTranscriptionAllowance(environment.DATABASE_URL);
  await registerTranscriptionRoutes(
    api,
    authentication.readSignedInUserId,
    transcriptionAllowance,
    new OpenAiLiveTranscriber({
      apiKey: environment.OPENAI_API_KEY ?? '',
      delay: TranscriptionConfig.RECOGNITION_DELAY,
    }),
    {
      authSecret: environment.AUTH_SECRET,
      dailySeconds: TranscriptionConfig.DAILY_AUDIO_SECONDS,
      available: Boolean(environment.OPENAI_API_KEY),
    },
  );
  registerAuthRoutes(
    api,
    authentication.auth,
    environment.AUTH_BASE_URL,
    Boolean(environment.GOOGLE_CLIENT_ID),
  );
  registerModelGateway(api, authentication.readSignedInUserId, environment, logger);

  api.addHook('onClose', async () => {
    await database.close();
    await authentication.close();
    await transcriptionAllowance.close();
    await voiceoverAllowance.close();
  });

  try {
    await api.listen({ host: environment.HOST, port: environment.PORT });
  } catch (error: unknown) {
    await api.close();

    throw error;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void api.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }

  logger.info(
    { port: environment.PORT, appEnvironment: environment.APP_ENV },
    'Tro API is listening.',
  );
}

void startApi().catch(() => {
  console.error('Tro API could not start. Check configuration and port availability.');
  process.exitCode = 1;
});
