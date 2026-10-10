import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MaterialPublicationSchema } from '../src/contracts/ClassroomMaterials.js';
import {
  AuthorResultSchema,
  LessonLanguage,
  LessonStatus,
  type GuidedLessonDetail,
  type GuidedLessonReply,
  type LessonPlan,
} from '../src/contracts/GuidedLessons.js';
import {
  buildPublicationLessonPassages,
  hashLessonText,
} from '../src/server/features/guidedLessons/application/BuildLessonInput.js';
import { GuidedLessonService } from '../src/server/features/guidedLessons/application/GuidedLessonService.js';
import type {
  LessonModel,
  LessonRenderer,
  LessonSpeech,
} from '../src/server/features/guidedLessons/application/LessonPorts.js';
import { validateLessonPlan } from '../src/server/features/guidedLessons/domain/ValidateLessonPlan.js';
import { DockerLessonCodeSandbox } from '../src/server/features/guidedLessons/infrastructure/DockerLessonCodeSandbox.js';
import {
  LessonCodeRequestSchema,
  LessonCodeSandboxError,
  type LessonCodeRequest,
  type LessonCodeSandbox,
} from '../src/server/features/guidedLessons/infrastructure/LessonCodeSandbox.js';
import { OpenAiLessonModel } from '../src/server/features/guidedLessons/infrastructure/OpenAiLessonModel.js';
import { OpenAiLessonSpeech } from '../src/server/features/guidedLessons/infrastructure/OpenAiLessonSpeech.js';
import {
  RemotionLessonAgent,
  type RemotionAgentMeasurement,
} from '../src/server/features/guidedLessons/infrastructure/RemotionLessonAgent.js';
import { createRemotionModelFetch } from '../src/server/features/guidedLessons/infrastructure/RemotionModelFetch.js';
import { BenchmarkLessonStore } from './BenchmarkLessonStore.js';
import { readGuidedLessonBenchmarkEnv } from './GuidedLessonBenchmarkEnv.js';
import {
  createBenchmarkModelFetch,
  readGuidedLessonBenchmarkOptions,
  sumBenchmarkModelUsage,
  type BenchmarkModelMeasurement,
  type BenchmarkOptions,
} from './GuidedLessonBenchmarkMeasurements.js';

const executeFile = promisify(execFile);

interface BenchmarkSpeechMeasurement {
  beatId: string;
  model: string;
  voice: string;
  submittedCharacters: number;
  requestId: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  audioBytes: number | null;
  wallTimeMs: number;
  completed: boolean;
}

interface BenchmarkRenderMeasurement {
  wallTimeMs: number;
  completed: boolean;
  artifacts: number;
  artifactBytes: number;
  videoArtifacts: number;
  videoBytes: number;
}

function createBenchmarkPublication(language: BenchmarkOptions['language']) {
  const materialId = randomUUID();
  const pageId = randomUUID();
  const code =
    'numbers = [2, 4, 6]\ntotal = 0\nfor number in numbers:\n    total = total + number\nprint(total)';
  const explanation =
    language === LessonLanguage.VI
      ? 'Biến total lưu tổng cộng dồn. Khởi tạo total bằng 0 trước vòng lặp. Mỗi lượt cộng number hiện tại vào total. Cuối cùng total bằng 12.'
      : 'The variable total stores a running total. Set total to zero before the loop. Each iteration adds the current number to total. The final total is twelve.';
  const text = `${explanation}\n\n${code}`;
  return {
    code,
    publication: MaterialPublicationSchema.parse({
      classId: randomUUID(),
      courseId: randomUUID(),
      teacherInstructions: '',
      sources: [
        {
          id: materialId,
          name: 'Synthetic benchmark lecture; no real classroom data',
          bytes: Buffer.byteLength(text),
          digest: hashLessonText(text),
          url: null,
        },
      ],
      draft: {
        summary: explanation,
        questions: [],
        sections: [
          {
            id: randomUUID(),
            title: 'Running total',
            instruction: 'Explain the accumulator one update at a time.',
            sourcePageIds: [pageId],
          },
        ],
        pages: [
          {
            id: pageId,
            materialId,
            location: 'Synthetic page 1',
            extractedText: text,
            preparedNote: '',
            teacherNote: '',
            warnings: [],
          },
        ],
      },
    }),
  };
}

function readTeacherDetail(reply: GuidedLessonReply): GuidedLessonDetail {
  if (reply.kind !== 'detail') {
    throw new Error('Benchmark did not receive the synthetic teacher detail.');
  }
  return reply.lesson;
}

/** Require a local, credential-free Linux/AMD64 image before submitting any model request. */
async function requireBenchmarkSandbox(image: string): Promise<void> {
  try {
    await executeFile('docker', ['info', '--format', '{{.OSType}}'], {
      timeout: 15_000,
      maxBuffer: 4096,
    });
    const inspected = await executeFile(
      'docker',
      ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image],
      { timeout: 15_000, maxBuffer: 4096 },
    );
    if (inspected.stdout.trim() !== 'linux/amd64') {
      throw new Error('Unsupported sandbox architecture.');
    }
  } catch {
    throw new Error(
      'The Linux/AMD64 lesson sandbox is unavailable. Build the lesson-renderer Docker target with --platform linux/amd64 before running this benchmark.',
    );
  }
}

function readRequestId(headers: Headers): string | null {
  const requestId = headers.get('x-request-id');
  return requestId && /^[a-zA-Z0-9_-]{1,200}$/.test(requestId) ? requestId : null;
}

async function saveBenchmarkArtifacts(store: BenchmarkLessonStore, directory: string) {
  const extensions = new Map([
    ['audio/wav', 'wav'],
    ['audio/mpeg', 'mp3'],
    ['video/mp4', 'mp4'],
    ['image/png', 'png'],
    ['application/json', 'json'],
    ['text/typescript', 'tsx'],
    ['text/plain', 'txt'],
  ]);
  const artifactDirectory = join(directory, 'Artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  const index = [];
  for (const artifact of store.artifacts.values()) {
    const filename = `${hashLessonText(artifact.artifactId)}.${extensions.get(artifact.mimeType) ?? 'bin'}`;
    await writeFile(join(artifactDirectory, filename), artifact.bytes);
    index.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      digest: artifact.digest,
      sceneId: artifact.sceneId,
      phase: artifact.phase,
      bytes: artifact.bytes.byteLength,
      file: `Artifacts/${filename}`,
    });
  }
  await writeFile(join(directory, 'Artifacts.json'), JSON.stringify(index, null, 2));
  return index;
}

/** Retain synthetic candidates independently of approved artifacts, including when a later stage fails. */
function createCandidateSavingSandbox(
  sandbox: LessonCodeSandbox,
  directory: string,
): LessonCodeSandbox {
  const saveInput = async (request: LessonCodeRequest): Promise<string> => {
    const validated = LessonCodeRequestSchema.parse(request);
    const candidate = join(directory, 'Candidates', hashLessonText(validated.source));
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, 'Source.tsx'), validated.source);
    await writeFile(
      join(candidate, 'Projection.json'),
      JSON.stringify(validated.projection, null, 2),
    );
    const input = join(
      candidate,
      hashLessonText(
        JSON.stringify({
          projection: validated.projection,
          durationInFrames: validated.durationInFrames,
        }),
      ),
    );
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'Projection.json'), JSON.stringify(validated.projection, null, 2));
    await writeFile(
      join(input, 'Input.json'),
      JSON.stringify(
        {
          benchmarkOnly: true,
          approved: false,
          durationInFrames: validated.durationInFrames,
          sourceDigest: hashLessonText(validated.source),
        },
        null,
        2,
      ),
    );
    return input;
  };
  const saveFailure = async (input: string, operation: string, error: unknown): Promise<void> => {
    await writeFile(
      join(input, `${operation}Failure.json`),
      JSON.stringify(
        {
          benchmarkOnly: true,
          approved: false,
          stage: error instanceof LessonCodeSandboxError ? error.stage : 'sandbox',
          diagnostic:
            error instanceof LessonCodeSandboxError
              ? error.message.slice(0, 4000)
              : 'The sandbox did not produce a completed output. Inspect the bounded stage measurements.',
        },
        null,
        2,
      ),
    );
  };
  return {
    async checkReady(signal) {
      await sandbox.checkReady?.(signal);
    },
    async preview(request, frames, signal) {
      const input = await saveInput(request);
      try {
        const preview = await sandbox.preview(request, frames, signal);
        for (const frame of preview.frames) {
          await writeFile(join(input, `Frame${String(frame.frame)}.png`), frame.bytes);
          await writeFile(
            join(input, `Geometry${String(frame.frame)}.json`),
            JSON.stringify(frame.geometry, null, 2),
          );
        }
        return preview;
      } catch (error) {
        await saveFailure(input, 'Preview', error);
        throw error;
      }
    },
    async renderVideo(request, signal) {
      const input = await saveInput(request);
      try {
        const video = await sandbox.renderVideo(request, signal);
        await writeFile(join(input, 'Candidate.mp4'), video);
        return video;
      } catch (error) {
        await saveFailure(input, 'Video', error);
        throw error;
      }
    },
  };
}

/** Manual paid-provider benchmark. All script approvals are synthetic and no release is ever created. */
async function runBenchmark(
  options: BenchmarkOptions,
  environment: ReturnType<typeof readGuidedLessonBenchmarkEnv>,
  directory: string,
): Promise<boolean> {
  await mkdir(directory, { recursive: true });
  const startedAt = new Date();
  const startTime = performance.now();
  const store = new BenchmarkLessonStore();
  const { publication, code } = createBenchmarkPublication(options.language);
  const teacherId = 'benchmark-only-teacher';
  store.publications.set(publication.courseId, publication);
  store.accesses.set(`${teacherId}:${publication.classId}`, {
    classId: publication.classId,
    teacherId,
    isTeacher: true,
    enrolled: false,
    courseRevisionId: publication.courseId,
  });
  const modelMeasurements: BenchmarkModelMeasurement[] = [];
  const modelResults: {
    stage: string;
    result: unknown;
    validationIssues: ReturnType<typeof validateLessonPlan>;
  }[] = [];
  const speechMeasurements: BenchmarkSpeechMeasurement[] = [];
  const renderMeasurements: BenchmarkRenderMeasurement[] = [];
  const agentMeasurements: RemotionAgentMeasurement[] = [];
  const codingProviderMeasurements: BenchmarkModelMeasurement[] = [];
  const failures: { lessonId: string; stage: string; code: string }[] = [];
  const stages: { status: LessonStatus; elapsedMs: number }[] = [];
  let activeStage = 'initializing';
  const realModel = new OpenAiLessonModel(
    environment.apiKey,
    environment.model,
    createBenchmarkModelFetch(
      () => activeStage,
      (measurement) => modelMeasurements.push(measurement),
    ),
  );
  const model: LessonModel = {
    countInput: (request, signal) => {
      activeStage = request.stage;
      return realModel.countInput(request, signal);
    },
    generate: async (request, signal) => {
      activeStage = request.stage;
      const generated = await realModel.generate(request, signal);
      const author = AuthorResultSchema.safeParse(generated.result);
      modelResults.push({
        stage: request.stage,
        result: generated.result,
        validationIssues:
          author.success && author.data.status === 'ready'
            ? validateLessonPlan(request.input, author.data.plan)
            : [],
      });
      return generated;
    },
  };
  let speechRequestId: string | null = null;
  let speechHttpStatus: number | null = null;
  const realSpeech = new OpenAiLessonSpeech(
    environment.apiKey,
    environment.speechModel,
    environment.speechVoice,
    async (input, requestOptions) => {
      const response = await fetch(input, requestOptions);
      speechRequestId = readRequestId(response.headers);
      speechHttpStatus = response.status;
      return response;
    },
  );
  const speech: LessonSpeech = {
    synthesize: async (request, signal) => {
      const startedAt = performance.now();
      speechRequestId = null;
      speechHttpStatus = null;
      const measurement: BenchmarkSpeechMeasurement = {
        beatId: request.beatId,
        model: environment.speechModel,
        voice: environment.speechVoice,
        submittedCharacters: Array.from(request.text).length,
        requestId: null,
        httpStatus: null,
        durationMs: null,
        audioBytes: null,
        wallTimeMs: 0,
        completed: false,
      };
      try {
        const generated = await realSpeech.synthesize(request, signal);
        measurement.durationMs = generated.durationMs;
        measurement.audioBytes = generated.bytes.byteLength;
        measurement.completed = true;
        return generated;
      } finally {
        measurement.requestId = speechRequestId;
        measurement.httpStatus = speechHttpStatus;
        measurement.wallTimeMs = Math.round(performance.now() - startedAt);
        speechMeasurements.push(measurement);
      }
    },
  };
  const agent = new RemotionLessonAgent(
    environment.apiKey,
    environment.codingModel,
    createCandidateSavingSandbox(
      new DockerLessonCodeSandbox({ image: environment.renderImage }),
      directory,
    ),
    {
      fetch: createBenchmarkModelFetch(
        () => 'remotionCoding',
        (measurement) => codingProviderMeasurements.push(measurement),
        createRemotionModelFetch(),
        { observeTransport: true },
      ),
      onMeasurement: (measurement) => agentMeasurements.push(measurement),
    },
  );
  const renderer: LessonRenderer = {
    checkReady: (signal) => agent.checkReady(signal),
    render: async (...arguments_: Parameters<LessonRenderer['render']>) => {
      const startedAt = performance.now();
      const measurement: BenchmarkRenderMeasurement = {
        wallTimeMs: 0,
        completed: false,
        artifacts: 0,
        artifactBytes: 0,
        videoArtifacts: 0,
        videoBytes: 0,
      };
      try {
        const rendered = await agent.render(...arguments_);
        measurement.completed = true;
        measurement.artifacts = rendered.artifacts.length;
        measurement.artifactBytes = rendered.artifacts.reduce(
          (sum, artifact) => sum + artifact.bytes.byteLength,
          0,
        );
        const videos = rendered.artifacts.filter((artifact) => artifact.mimeType === 'video/mp4');
        measurement.videoArtifacts = videos.length;
        measurement.videoBytes = videos.reduce(
          (sum, artifact) => sum + artifact.bytes.byteLength,
          0,
        );
        return rendered;
      } finally {
        measurement.wallTimeMs = Math.round(performance.now() - startedAt);
        renderMeasurements.push(measurement);
      }
    },
  };
  const service = new GuidedLessonService(
    store,
    model,
    speech,
    renderer,
    () => new Date(),
    (failure) => failures.push(failure),
  );
  let lesson: GuidedLessonDetail | null = null;
  let outcome = 'failed';
  const lifetime = { cancelled: false };
  let finalFailureStage: string | null = null;
  const cancel = (): void => {
    lifetime.cancelled = true;
    service.close();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const refresh = async (): Promise<GuidedLessonDetail> => {
    if (!lesson) {
      throw new Error('The synthetic lesson was not created.');
    }
    lesson = readTeacherDetail(
      await service.read(teacherId, {
        action: 'detail',
        classId: publication.classId,
        lessonId: lesson.id,
      }),
    );
    if (stages.at(-1)?.status !== lesson.status) {
      stages.push({ status: lesson.status, elapsedMs: Math.round(performance.now() - startTime) });
      console.info(`Benchmark stage: ${lesson.status}`);
    }
    return lesson;
  };
  const advanceTo = async (expected: LessonStatus): Promise<GuidedLessonDetail> => {
    for (let step = 0; step < 200; step += 1) {
      if (lifetime.cancelled) {
        throw new Error('Benchmark cancelled.');
      }
      await service.prepareNextLesson();
      const current = await refresh();
      if (current.status === expected) {
        return current;
      }
      if (
        [
          LessonStatus.FAILED,
          LessonStatus.USAGE_UNCERTAIN,
          LessonStatus.BUDGET_BLOCKED,
          LessonStatus.NEEDS_TEACHER_INPUT,
          LessonStatus.CANCELLED,
        ].some((status) => status === current.status)
      ) {
        throw new Error('Benchmark stopped before the requested stage.');
      }
    }
    throw new Error('Benchmark exceeded its stage limit.');
  };
  try {
    const passages = buildPublicationLessonPassages(publication);
    const sourceRefs = passages.map((passage) => ({
      passageId: passage.passageId,
      startOffset: 0,
      endOffset: passage.text.length,
    }));
    lesson = readTeacherDetail(
      await service.execute(teacherId, {
        action: 'create',
        commandId: randomUUID(),
        classId: publication.classId,
        courseRevisionId: publication.courseId,
        conceptId: 'accumulator',
        objective:
          options.language === LessonLanguage.VI
            ? 'Giải thích từng bước thay đổi của tổng cộng dồn.'
            : 'Explain how each loop step changes the running total.',
        audience: 'Beginning Python learners',
        language: options.language,
        targetDurationSeconds: options.seconds,
        passageIds: passages.map((passage) => passage.passageId),
        teacherInstructions: `Synthetic pricing benchmark only. Keep narration concise for a ${String(options.seconds)} second target. Use the minimum scenes required for a watch, prediction checkpoint and continuation. This material has no real teacher or student.`,
        codeApproval: { code, sourceRefs, variantOfCodeBlockId: null },
        practiceCodeApproval: null,
      }),
    );
    const teacherCommand = (current: GuidedLessonDetail) => ({
      commandId: randomUUID(),
      classId: publication.classId,
      lessonId: current.id,
      expectedVersion: current.version,
    });
    lesson = readTeacherDetail(
      await service.execute(teacherId, { action: 'start', ...teacherCommand(lesson) }),
    );
    const scripted = await advanceTo(LessonStatus.AWAITING_SCRIPT_APPROVAL);
    const approvedPlan: LessonPlan | null = scripted.plan;
    if (
      !approvedPlan ||
      !scripted.input ||
      !scripted.contentHash ||
      validateLessonPlan(scripted.input, approvedPlan).length > 0
    ) {
      throw new Error('The benchmark script failed canonical validation.');
    }
    await writeFile(join(directory, 'LessonScript.json'), JSON.stringify(approvedPlan, null, 2));
    await writeFile(
      join(directory, 'ScriptApproval.json'),
      JSON.stringify(
        {
          benchmarkOnly: true,
          humanApproved: false,
          reason: 'Synthetic isolated benchmark; canonical validation passed. Never released.',
          contentHash: scripted.contentHash,
          sceneIds: approvedPlan.scenes.map((scene) => scene.sceneId),
        },
        null,
        2,
      ),
    );
    lesson = readTeacherDetail(
      await service.execute(teacherId, {
        action: 'approveScript',
        ...teacherCommand(scripted),
        contentHash: scripted.contentHash,
        acknowledgedSceneIds: approvedPlan.scenes.map((scene) => scene.sceneId),
      }),
    );
    lesson = readTeacherDetail(
      await service.execute(teacherId, { action: 'render', ...teacherCommand(lesson) }),
    );
    lesson = await advanceTo(LessonStatus.PREVIEW_READY);
    outcome = 'previewReady';
  } catch {
    outcome = lifetime.cancelled ? 'cancelled' : 'failed';
    finalFailureStage = failures.at(-1)?.stage ?? lesson?.status ?? activeStage;
  } finally {
    service.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    const artifacts = await saveBenchmarkArtifacts(store, directory);
    await writeFile(join(directory, 'ModelResults.json'), JSON.stringify(modelResults, null, 2));
    if (lesson) {
      await writeFile(join(directory, 'LessonDetail.json'), JSON.stringify(lesson, null, 2));
    }
    const modelUsage = sumBenchmarkModelUsage(modelMeasurements);
    const codingCalls = agentMeasurements.filter((measurement) => measurement.kind === 'model');
    const codingInput = codingCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0);
    const codingOutput = codingCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
    await writeFile(
      join(directory, 'BenchmarkReport.json'),
      JSON.stringify(
        {
          schemaVersion: '1.0',
          benchmarkOnly: true,
          released: false,
          syntheticScriptApproval: true,
          humanQualityApproval: false,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          wallTimeMs: Math.round(performance.now() - startTime),
          options,
          execution: {
            hostPlatform: process.platform,
            hostArchitecture: process.arch,
            renderPlatform: 'linux/amd64',
            renderImage: environment.renderImage,
          },
          models: {
            content: environment.model,
            coding: environment.codingModel,
            speech: environment.speechModel,
            voice: environment.speechVoice,
            contentVersion: realModel.version,
            codingVersion: agent.version,
          },
          outcome,
          finalStatus: lesson?.status ?? null,
          finalFailureStage,
          stages,
          failures,
          modelUsage,
          codingUsage: {
            inputTokens: codingInput,
            outputTokens: codingOutput,
            totalTokens: codingInput + codingOutput,
            cachedInputTokens: codingCalls.reduce(
              (sum, call) => sum + (call.cachedInputTokens ?? 0),
              0,
            ),
            cacheWriteInputTokens: codingCalls.reduce(
              (sum, call) => sum + (call.cacheWriteInputTokens ?? 0),
              0,
            ),
            reasoningOutputTokens: codingCalls.reduce(
              (sum, call) => sum + (call.reasoningOutputTokens ?? 0),
              0,
            ),
            unknownRequests: codingCalls.filter(
              (call) => call.inputTokens === null || call.outputTokens === null,
            ).length,
            unknownCachedInputRequests: codingCalls.filter(
              (call) => call.cachedInputTokens === null,
            ).length,
            unknownCacheWriteRequests: codingCalls.filter(
              (call) => call.cacheWriteInputTokens === null,
            ).length,
            unknownReasoningRequests: codingCalls.filter(
              (call) => call.reasoningOutputTokens === null,
            ).length,
          },
          knownTotalTokens: modelUsage.totalTokens + codingInput + codingOutput,
          speech: {
            attemptedRequests: speechMeasurements.length,
            completedRequests: speechMeasurements.filter((measurement) => measurement.completed)
              .length,
            submittedCharacters: speechMeasurements.reduce(
              (sum, measurement) => sum + measurement.submittedCharacters,
              0,
            ),
            completedAudioSeconds: speechMeasurements.reduce(
              (sum, measurement) => sum + (measurement.durationMs ?? 0) / 1000,
              0,
            ),
          },
          modelMeasurements,
          agentMeasurements,
          codingProviderMeasurements,
          speechMeasurements,
          renderMeasurements,
          artifacts,
          limitations: [
            'Token cache and reasoning details are subsets of reported totals, not additional usage.',
            'Subset totals include only reported fields; unknown subset request counts distinguish unavailable details from provider-reported zero.',
            'Unknown usage is excluded from known totals and must be reconciled using provider request IDs.',
            'The speech endpoint returns WAV without token billing details; characters and seconds are measured units.',
            'A short synthetic run cannot establish model quality, pronunciation, customer learning or production pricing.',
            'Synthetic script approval is for this isolated benchmark only. No preview approval or release occurs.',
          ],
        },
        null,
        2,
      ),
    );
    console.info(`Benchmark ${outcome}. Report: ${join(directory, 'BenchmarkReport.json')}`);
  }
  return outcome === 'previewReady';
}

async function main(): Promise<void> {
  try {
    const options = readGuidedLessonBenchmarkOptions(process.argv.slice(2));
    if (options.help) {
      console.info(
        'Manual live-provider Guided Lessons benchmark. Uses paid OpenAI calls and a local isolated Docker renderer; no database or release.\nOptions: --language en|vi --seconds 30..300 --runs 1..3\nDefault: one 30-second synthetic lesson. Results: .tro-development/guided-lesson-benchmark/<id>/BenchmarkReport.json',
      );
      return;
    }
    const environment = readGuidedLessonBenchmarkEnv(process.env);
    await requireBenchmarkSandbox(environment.renderImage);
    const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
    const directory = resolve('.tro-development/guided-lesson-benchmark', id);
    console.info(
      `Starting ${String(options.runs)} live-provider benchmark run(s). Output: ${directory}`,
    );
    for (let run = 1; run <= options.runs; run += 1) {
      const succeeded = await runBenchmark(
        options,
        environment,
        join(directory, `Run${String(run)}`),
      );
      if (!succeeded) {
        process.exitCode = 1;
        break;
      }
    }
  } catch {
    console.error(
      'Guided lesson benchmark could not start or save its report. Check CLI options, provider configuration, the local AMD64 sandbox image and output permissions. No raw provider or credential details are printed.',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
