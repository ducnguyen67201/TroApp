import { createPrismaGuidedLessonStore } from './persistence/PrismaGuidedLessonStore.js';
import { GuidedLessonService } from './features/guidedLessons/application/GuidedLessonService.js';
import { GuidedLessonRunner } from './features/guidedLessons/application/GuidedLessonRunner.js';
import { registerGuidedLessonRoutes } from './features/guidedLessons/infrastructure/RegisterGuidedLessonRoutes.js';
import { OpenAiLessonModel } from './features/guidedLessons/infrastructure/OpenAiLessonModel.js';
import { OpenAiLessonSpeech } from './features/guidedLessons/infrastructure/OpenAiLessonSpeech.js';
import { RemotionLessonRenderer } from './features/guidedLessons/infrastructure/RemotionLessonRenderer.js';
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
    collectionPolicy: environment.CLASSROOM_INSIGHT_COLLECTION_POLICY ?? 'classroom-learning-v1',
    retentionDays: environment.CLASSROOM_INSIGHT_RETENTION_DAYS ?? 180,
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
    environment.CLASSROOM_INSIGHT_RETENTION_DAYS,
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
  const practice = createPrismaPracticeCheckStore(environment.DATABASE_URL, capturePolicy);
  registerPracticeCheckRoutes(
    api,
    authentication.readSignedInUserId,
    new PracticeCheckService(
      practice.store,
      new PracticeAssessmentService(
        [
          new LlmCriterionEvaluator(
            new OpenAiPracticeCheckEvaluator(
              environment.OPENAI_API_KEY,
              environment.PRACTICE_CHECK_MODEL ?? 'gpt-5.4',
            ),
          ),
          new ExactOutputEvaluator(),
          new ScratchStructureEvaluator(),
        ],
        new PreparePracticeEvidence(new ExtractPracticeArtifact(new MaterialExtractorWorker())),
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
        {
          stageOutputTokens: environment.MATERIAL_STAGE_OUTPUT_TOKENS,
          compositionOutputTokens: environment.MATERIAL_COMPOSITION_OUTPUT_TOKENS,
          compositionTimeoutMs: environment.MATERIAL_COMPOSITION_TIMEOUT_MS,
        },
        (event) => {
          if (event.state === MaterialProviderRequestState.FAILED) {
            logger.warn(event, 'classroom.materials.provider.request');
          } else {
            logger.info(event, 'classroom.materials.provider.request');
          }
        },
      ),
      {
        calls: environment.MATERIAL_JOB_CALLS,
        inputTokens: environment.MATERIAL_JOB_INPUT_TOKENS,
        outputTokens: environment.MATERIAL_JOB_OUTPUT_TOKENS,
        stageInputTokens: environment.MATERIAL_STAGE_INPUT_TOKENS,
        stageOutputTokens: environment.MATERIAL_STAGE_OUTPUT_TOKENS,
        compositionOutputTokens: environment.MATERIAL_COMPOSITION_OUTPUT_TOKENS,
        compositionTimeoutMs: environment.MATERIAL_COMPOSITION_TIMEOUT_MS,
        deadlineMs: environment.MATERIAL_JOB_DEADLINE_MS,
      },
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
  const guidedLessons = createPrismaGuidedLessonStore(environment.DATABASE_URL);
  const guidedLessonService = new GuidedLessonService(
    guidedLessons.store,
    new OpenAiLessonModel(environment.OPENAI_API_KEY, environment.GUIDED_LESSON_MODEL),
    new OpenAiLessonSpeech(
      environment.OPENAI_API_KEY,
      environment.GUIDED_LESSON_SPEECH_MODEL,
      environment.GUIDED_LESSON_SPEECH_VOICE,
    ),
    new RemotionLessonRenderer(undefined, (event) => {
      logger.warn(event, 'guided.lesson.render.failed');
    }),
    () => new Date(),
    (event) => {
      logger.warn(event, 'guided.lesson.stage.failed');
    },
  );
  const guidedLessonRunner = new GuidedLessonRunner(guidedLessonService, () => {
    logger.warn({ operation: 'guided-lesson-runner' }, 'guided.lesson.runner.failed');
  });
  registerGuidedLessonRoutes(
    api,
    authentication.readSignedInUserId,
    guidedLessonService,
    logger,
    () => {
      guidedLessonRunner.wake();
    },
  );
  guidedLessonRunner.start();
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
    await materialRunner.close();
    await guidedLessonRunner.close();
    await guidedLessons.close();
    await database.close();
    await authentication.close();
    await transcriptionAllowance.close();
    await voiceoverAllowance.close();
    await classroom.close();
    await practice.close();
    await insights.close();
  });

  try {
    await retentionRunner.start();
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
