import { ClassroomInsightService } from './features/classroom/application/ClassroomInsightService.js';
import { registerClassroomInsightRoutes } from './features/classroom/infrastructure/RegisterClassroomInsightRoutes.js';
import { ClassroomInsightRetentionRunner } from './features/classroom/infrastructure/ClassroomInsightRetentionRunner.js';
import { createPrismaClassroomInsightStore } from './persistence/PrismaClassroomInsightStore.js';
import { MaterialProviderRequestState } from './features/materials/application/MaterialGeneration.js';
import { PracticeAssessmentService } from './features/classroom/application/PracticeAssessmentService.js';
import { PreparePracticeEvidence } from './features/classroom/application/PreparePracticeEvidence.js';
import { ExactOutputEvaluator } from './features/classroom/application/ExactOutputEvaluator.js';
import { ScratchStructureEvaluator } from './features/classroom/application/ScratchStructureEvaluator.js';
import { LlmCriterionEvaluator } from './features/classroom/infrastructure/LlmCriterionEvaluator.js';
import { ExtractPracticeArtifact } from './features/classroom/infrastructure/ExtractPracticeArtifact.js';
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
import { OpenAiSpeechProvider } from './features/voiceover/OpenAiSpeechProvider.js';
import {
  VoiceoverConfig,
  readVoiceoverAllowanceConfig,
  readClassroomInsightConfig,
  readPracticeCheckConfig,
  readMaterialConfig,
} from './config/Index.js';
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
import { PetWorldService } from './features/petWorld/application/PetWorldService.js';
import { registerPetWorldRoutes } from './features/petWorld/infrastructure/RegisterPetWorldRoutes.js';
import { createPrismaPetWorldStore } from './persistence/PrismaPetWorldStore.js';

async function startApi(): Promise<void> {
  const environment = readServerEnv(process.env);
  const insightConfig = readClassroomInsightConfig();
  const practiceConfig = readPracticeCheckConfig();
  const materialConfig = readMaterialConfig();
  const voiceoverConfig = readVoiceoverAllowanceConfig();
  const logger = createServerLogger(environment.APP_ENV);
  const database = createPrismaDatabaseStatus(environment.DATABASE_URL, logger);
  const authentication = createAuthDatabase(environment);
  const api = createApi(database);
  const voiceoverAllowance = createPrismaVoiceoverAllowance(
    environment.DATABASE_URL,
    voiceoverConfig,
  );
  registerVoiceoverRoutes(
    api,
    authentication.readSignedInUserId,
    voiceoverAllowance,
    new OpenAiSpeechProvider({
      apiKey: environment.OPENAI_API_KEY,
      modelId: VoiceoverConfig.MODEL_ID,
      voices: VoiceoverConfig.VOICES,
      instructions: VoiceoverConfig.INSTRUCTIONS,
    }),
  );
  const capturePolicy = {
    captureClassIds: [],
    captureAllClasses: true,
    ...insightConfig,
  };
  const classroom = createPrismaClassroomStore(environment.DATABASE_URL, capturePolicy);
  const insights = createPrismaClassroomInsightStore(environment.DATABASE_URL, capturePolicy, {
    resumeStoredRetentionPolicies: true,
  });
  registerClassroomInsightRoutes(
    api,
    authentication.readSignedInUserId,
    new ClassroomInsightService(insights.store, capturePolicy),
    logger,
  );
  const retentionRunner = new ClassroomInsightRetentionRunner(
    insights,
    insightConfig.retentionDays,
    () => {
      logger.warn({ operation: 'purge-expired-insights' }, 'classroom.insights.retention.failed');
    },
  );
  registerClassroomRoutes(
    api,
    authentication.readSignedInUserId,
    new ClassroomService(classroom.store),
    logger,
  );
  const petWorld = createPrismaPetWorldStore(environment.DATABASE_URL);
  registerPetWorldRoutes(
    api,
    authentication.readSignedInUserId,
    new PetWorldService(petWorld.store),
    logger,
  );
  const petRetentionRunner = new ClassroomInsightRetentionRunner(
    petWorld,
    capturePolicy.retentionDays,
    () => {
      logger.warn({ operation: 'purge-expired-pet-recognition' }, 'petWorld.retention.failed');
    },
  );
  const practice = createPrismaPracticeCheckStore(environment.DATABASE_URL, capturePolicy);
  registerPracticeCheckRoutes(
    api,
    authentication.readSignedInUserId,
    new PracticeCheckService(
      practice.store,
      new PracticeAssessmentService(
        [
          new LlmCriterionEvaluator(
            new OpenAiPracticeCheckEvaluator(environment.OPENAI_API_KEY, practiceConfig.model),
          ),
          new ExactOutputEvaluator(),
          new ScratchStructureEvaluator(),
        ],
        new PreparePracticeEvidence(new ExtractPracticeArtifact(new MaterialExtractorWorker())),
      ),
      practiceConfig.policy,
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
        {
          stageOutputTokens: materialConfig.generation.stageOutputTokens,
          compositionOutputTokens: materialConfig.generation.compositionOutputTokens,
          compositionTimeoutMs: materialConfig.generation.compositionTimeoutMs,
        },
        (event) => {
          if (event.state === MaterialProviderRequestState.FAILED) {
            logger.warn(event, 'classroom.materials.provider.request');
          } else {
            logger.info(event, 'classroom.materials.provider.request');
          }
        },
      ),
      materialConfig.generation,
      (event) => {
        if (event.rejected) {
          logger.warn(event, 'classroom.materials.stage.rejected');
        } else {
          logger.info(event, 'classroom.materials.stage.completed');
        }
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
    await retentionRunner.close();
    await petRetentionRunner.close();
    await materialRunner.close();
    await database.close();
    await authentication.close();
    await transcriptionAllowance.close();
    await voiceoverAllowance.close();
    await classroom.close();
    await practice.close();
    await insights.close();
    await petWorld.close();
  });

  try {
    await retentionRunner.start();
    await petRetentionRunner.start();
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
