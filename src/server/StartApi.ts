import { PracticeCheckService } from './features/classroom/application/PracticeCheckService.js';
import { OpenAiPracticeCheckEvaluator } from './features/classroom/infrastructure/OpenAiPracticeCheckEvaluator.js';
import { registerPracticeCheckRoutes } from './features/classroom/infrastructure/RegisterPracticeCheckRoutes.js';
import { createPrismaPracticeCheckStore } from './persistence/PrismaPracticeCheckStore.js';
import { PrepareMaterialCollection } from './features/materials/application/PrepareMaterialCollection.js';
import { MaterialService } from './features/materials/application/MaterialService.js';
import { MaterialPreparationRunner } from './features/materials/application/MaterialPreparationRunner.js';
import { MaterialExtractorWorker } from './features/materials/infrastructure/MaterialExtractorWorker.js';
import { OpenAiMaterialPreparation } from './features/materials/infrastructure/OpenAiMaterialPreparation.js';
import { registerMaterialRoutes } from './features/materials/infrastructure/RegisterMaterialRoutes.js';
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
import { createPrismaClassroomStore } from './persistence/PrismaClassroomStore.js';
import { ClassroomService } from './features/classroom/application/ClassroomService.js';
import { registerClassroomRoutes } from './features/classroom/infrastructure/RegisterClassroomRoutes.js';

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
  const classroom = createPrismaClassroomStore(environment.DATABASE_URL);
  registerClassroomRoutes(
    api,
    authentication.readSignedInUserId,
    new ClassroomService(classroom.store),
    logger,
  );
  const practice = createPrismaPracticeCheckStore(environment.DATABASE_URL);
  registerPracticeCheckRoutes(
    api,
    authentication.readSignedInUserId,
    new PracticeCheckService(
      practice.store,
      new OpenAiPracticeCheckEvaluator(
        environment.OPENAI_API_KEY,
        environment.PRACTICE_CHECK_MODEL ?? 'gpt-5.4',
      ),
      {
        dailyChecks: environment.PRACTICE_CHECK_DAILY_LIMIT ?? 30,
        minuteChecks: environment.PRACTICE_CHECK_MINUTE_LIMIT ?? 5,
      },
      () => new Date(),
      (event) => {
        logger.info(event, 'classroom.practice.lifecycle');
      },
    ),
    logger,
  );
  const materials = new MaterialService(
    classroom.store,
    new MaterialExtractorWorker(),
    new PrepareMaterialCollection(
      classroom.store,
      new OpenAiMaterialPreparation(
        environment.OPENAI_API_KEY,
        environment.MATERIAL_STAGE_OUTPUT_TOKENS,
      ),
      {
        calls: environment.MATERIAL_JOB_CALLS,
        inputTokens: environment.MATERIAL_JOB_INPUT_TOKENS,
        outputTokens: environment.MATERIAL_JOB_OUTPUT_TOKENS,
        stageInputTokens: environment.MATERIAL_STAGE_INPUT_TOKENS,
        stageOutputTokens: environment.MATERIAL_STAGE_OUTPUT_TOKENS,
        deadlineMs: environment.MATERIAL_JOB_DEADLINE_MS,
      },
      (event) => {
        logger.info(event, 'classroom.materials.stage.completed');
      },
    ),
    () => new Date(),
    (event) => {
      logger.warn(event, 'classroom.materials.preparation.failed');
    },
  );
  registerMaterialRoutes(api, authentication.readSignedInUserId, materials, logger);
  const materialRunner = new MaterialPreparationRunner(materials, () => {
    logger.warn({ event: 'material.runner.failed' }, 'Material preparation runner failed.');
  });
  materialRunner.start();
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
    await materialRunner.close();
    await database.close();
    await authentication.close();
    await transcriptionAllowance.close();
    await voiceoverAllowance.close();
    await classroom.close();
    await practice.close();
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
