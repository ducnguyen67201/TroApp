import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  LessonLayout,
  LessonVideoStatus,
  LessonVideoStage,
} from '../../../../src/contracts/LessonVideos.js';
import { readLessonVideoConfig } from '../../../../src/server/config/LessonVideoConfig.js';
import type {
  StoredLesson,
  LessonVideoStore,
  LessonContentProvider,
  LessonSpeechProvider,
  LessonRenderer,
} from '../../../../src/server/features/lessonVideos/application/LessonVideoPorts.js';

export function createLessonFixture(): StoredLesson {
  const settings = readLessonVideoConfig();
  return {
    id: randomUUID(),
    ownerId: randomUUID(),
    requestId: randomUUID(),
    requestHash: 'fixture',
    recordVersion: 0,
    classId: randomUUID(),
    title: 'Boolean',
    prompt: 'Explain Boolean',
    locale: 'vi',
    revision: 1,
    status: LessonVideoStatus.RUNNING,
    stage: LessonVideoStage.CONTENT,
    error: null,
    screens: [],
    videoId: null,
    videoRevision: null,
    inputTokens: 0,
    outputTokens: 0,
    reservedMicroUsd: 108000,
    usageUncertain: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canContinue: false,
    sources: [{ id: randomUUID(), name: 'Boolean', text: 'Boolean values are true and false.' }],
    settings,
    rendererBuild: 'fixture-v1',
    contentStarted: false,
    contentUsage: null,
    speechCharacters: 0,
    combineAttempts: 0,
    deadline: new Date(Date.now() + 600000).toISOString(),
    claimId: randomUUID(),
  };
}

export function createLessonPorts(initial: StoredLesson) {
  let saved = structuredClone(initial);
  const artifacts = new Map<string, Parameters<LessonVideoStore['saveStageResult']>[1]>();
  const store = {
    findRequest: vi.fn<LessonVideoStore['findRequest']>().mockResolvedValue(null),
    list: vi.fn<LessonVideoStore['list']>(() => Promise.resolve([saved])),
    read: vi.fn<LessonVideoStore['read']>(() => Promise.resolve(saved)),
    createLessonWithReservation: vi.fn<LessonVideoStore['createLessonWithReservation']>(
      (lesson) => {
        saved = lesson;
        return Promise.resolve(saved);
      },
    ),
    saveStageResult: vi.fn<LessonVideoStore['saveStageResult']>((lesson, artifact) => {
      saved = { ...lesson, recordVersion: lesson.recordVersion + 1 };
      if (artifact) {
        artifacts.set(artifact.id, artifact);
      }
      return Promise.resolve(saved);
    }),
    claimNextLesson: vi.fn<LessonVideoStore['claimNextLesson']>(() => Promise.resolve(saved)),
    renewClaim: vi.fn<LessonVideoStore['renewClaim']>().mockResolvedValue(true),
    readArtifact: vi.fn<LessonVideoStore['readArtifact']>((_lessonId, id) =>
      Promise.resolve(artifacts.get(id) ?? null),
    ),
    deleteLesson: vi.fn<LessonVideoStore['deleteLesson']>().mockResolvedValue(undefined),
    close: vi.fn<LessonVideoStore['close']>().mockResolvedValue(undefined),
  } satisfies LessonVideoStore;
  const content = {
    available: true,
    count: vi.fn<LessonContentProvider['count']>().mockResolvedValue(1000),
    generate: vi.fn<LessonContentProvider['generate']>().mockResolvedValue({
      content: {
        title: 'Boolean',
        screens: Array.from({ length: 3 }, () => ({
          layout: LessonLayout.EXPLANATION,
          title: 'True and false',
          points: ['Boolean has two values.'],
          narration: 'A Boolean value is true or false.',
        })),
      },
      usage: { inputTokens: 1000, outputTokens: 500, cachedTokens: 0, requestId: 'fixture' },
    }),
  } satisfies LessonContentProvider;
  const speech = {
    synthesize: vi
      .fn<LessonSpeechProvider['synthesize']>()
      .mockResolvedValue({ bytes: new Uint8Array([1, 2]), durationSeconds: 5 }),
  } satisfies LessonSpeechProvider;
  const renderer = {
    readBuildId: vi.fn<LessonRenderer['readBuildId']>().mockResolvedValue('fixture-v1'),
    render: vi.fn<LessonRenderer['render']>().mockResolvedValue(new Uint8Array([1, 2, 3])),
  } satisfies LessonRenderer;
  return { store, content, speech, renderer, readSaved: () => saved };
}
