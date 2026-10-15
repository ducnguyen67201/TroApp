import { z } from 'zod';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import {
  LessonVideoSchema,
  LessonVideoStatus,
  LessonVideoFailure,
  LessonArtifactKind,
} from '#contracts/LessonVideos.js';
import { LessonVideoConfigSchema } from '../config/LessonVideoConfig.js';
import {
  LessonModelAttemptSchema,
  LessonModelUsageSchema,
  StoredLessonVisualSchema,
} from '#contracts/LessonVisuals.js';
import {
  beginLessonModelAttempt,
  settleLessonModelAttempt,
  preservesLessonModelAttempts,
} from '../features/lessonVideos/domain/LessonModelAttempts.js';
import { LessonVideoError } from '../features/lessonVideos/domain/LessonVideoRules.js';
import type {
  LessonVideoStore,
  StoredLesson,
} from '../features/lessonVideos/application/LessonVideoPorts.js';

const storedSchema = LessonVideoSchema.extend({
  stateVersion: z.number().int().min(1).max(2).default(1),
  visuals: z.array(StoredLessonVisualSchema).max(2).default([]),
  modelAttempts: z.array(LessonModelAttemptSchema).max(6).default([]),
  ownerId: z.string(),
  requestId: z.uuid(),
  requestHash: z.string(),
  recordVersion: z.number().int(),
  sources: z.array(z.strictObject({ id: z.string(), name: z.string(), text: z.string() })),
  settings: LessonVideoConfigSchema,
  rendererBuild: z.string(),
  contentStarted: z.boolean(),
  contentUsage: LessonModelUsageSchema.nullable().default(null),
  speechCharacters: z.number().int().nonnegative(),
  combineAttempts: z.number().int(),
  renderRecoveries: z.number().int().min(0).max(1).default(0),
  deadline: z.string(),
  claimId: z.uuid().nullable(),
});
type Row = Prisma.LessonVideoGetPayload<{ include: { screens: true } }>;

function readLesson(row: Row): StoredLesson {
  const base = z.record(z.string(), z.unknown()).parse(row.state);
  return storedSchema.parse({
    ...base,
    screens: [...row.screens].sort((a, b) => a.position - b.position).map((screen) => screen.state),
    claimId: row.claimId,
    recordVersion: row.recordVersion,
    status: row.status,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function writeState(lesson: StoredLesson): Prisma.InputJsonObject {
  return z
    .record(z.string(), z.json())
    .parse(Object.fromEntries(Object.entries(lesson).filter(([key]) => key !== 'screens')));
}

/** All allowance, job and artifact writes use the same transaction-scoped client. */
export function createPrismaLessonVideoStore(databaseUrl: string): LessonVideoStore {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  async function transact<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2034', 'P2002'].includes(error.code) ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    throw new LessonVideoError(LessonVideoFailure.STALE);
  }

  const store: LessonVideoStore = {
    async findRequest(ownerId, requestId) {
      const row = await client.lessonVideo.findUnique({
        where: { ownerId_requestId: { ownerId, requestId } },
        include: { screens: true },
      });
      return row ? readLesson(row) : null;
    },
    async list(ownerId, administeredClassIds) {
      return (
        await client.lessonVideo.findMany({
          where: administeredClassIds
            ? {
                OR: administeredClassIds.map((classId) => ({
                  state: { path: ['classId'], equals: classId },
                })),
              }
            : { ownerId },
          include: { screens: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      ).map(readLesson);
    },
    async read(id) {
      const row = await client.lessonVideo.findUnique({
        where: { id },
        include: { screens: true },
      });
      return row ? readLesson(row) : null;
    },
    async createLessonWithReservation(lesson) {
      return transact(async (transaction) => {
        const existing = await transaction.lessonVideo.findUnique({
          where: { ownerId_requestId: { ownerId: lesson.ownerId, requestId: lesson.requestId } },
          include: { screens: true },
        });
        if (existing) {
          const saved = readLesson(existing);
          if (saved.requestHash !== lesson.requestHash) {
            throw new LessonVideoError(LessonVideoFailure.STALE);
          }
          return saved;
        }
        if (
          (await transaction.lessonVideo.count({ where: { ownerId: lesson.ownerId } })) >=
          lesson.settings.render.maxLessonsPerTeacher
        ) {
          throw new LessonVideoError(LessonVideoFailure.BUDGET);
        }
        const day = new Date().toISOString().slice(0, 10);
        const characters = lesson.settings.speech.characters * lesson.settings.speech.attempts;
        for (const scope of ['global', `teacher:${lesson.ownerId}`]) {
          const global = scope === 'global';
          const current = await transaction.lessonVideoAllowance.upsert({
            where: { scope_day: { scope, day } },
            create: { scope, day, reservedMicroUsd: 0, characters: 0 },
            update: {},
          });
          if (
            current.reservedMicroUsd + lesson.reservedMicroUsd >
              (global
                ? lesson.settings.budget.globalMicroUsd
                : lesson.settings.budget.teacherMicroUsd) ||
            current.characters + characters >
              (global
                ? lesson.settings.budget.globalCharacters
                : lesson.settings.budget.teacherCharacters)
          ) {
            throw new LessonVideoError(LessonVideoFailure.BUDGET);
          }
          await transaction.lessonVideoAllowance.update({
            where: { scope_day: { scope, day } },
            data: {
              reservedMicroUsd: { increment: lesson.reservedMicroUsd },
              characters: { increment: characters },
            },
          });
        }
        const row = await transaction.lessonVideo.create({
          data: {
            id: lesson.id,
            ownerId: lesson.ownerId,
            requestId: lesson.requestId,
            status: lesson.status,
            revision: lesson.revision,
            state: writeState(lesson),
          },
          include: { screens: true },
        });
        return readLesson(row);
      });
    },
    async saveStageResult(lesson, artifact) {
      return transact(async (transaction) => {
        const previous = await transaction.lessonVideo.findUnique({
          where: { id: lesson.id },
          include: { screens: true },
        });
        const saved = previous ? readLesson(previous) : null;
        if (
          !saved ||
          !preservesLessonModelAttempts(saved, lesson) ||
          (lesson.revision === saved.revision &&
            lesson.renderRecoveries < saved.renderRecoveries) ||
          lesson.renderRecoveries > lesson.settings.render.recoveries
        ) {
          throw new LessonVideoError(LessonVideoFailure.STALE);
        }
        const changed = await transaction.lessonVideo.updateMany({
          where: { id: lesson.id, recordVersion: lesson.recordVersion },
          data: {
            status: lesson.status,
            revision: lesson.revision,
            claimId: lesson.claimId,
            state: writeState(lesson),
            recordVersion: { increment: 1 },
            ...(lesson.claimId === null ? { leaseUntil: null } : {}),
          },
        });
        if (changed.count !== 1) {
          throw new LessonVideoError(LessonVideoFailure.STALE);
        }
        if (artifact) {
          const bytes = await transaction.lessonVideoArtifact.aggregate({
            where: { lesson: { ownerId: lesson.ownerId } },
            _sum: { byteLength: true },
          });
          if (
            (bytes._sum.byteLength ?? 0) + artifact.bytes.byteLength >
            lesson.settings.render.maxStoredBytes
          ) {
            throw new LessonVideoError(LessonVideoFailure.BUDGET);
          }
          await transaction.lessonVideoArtifact.create({
            data: {
              ...artifact,
              bytes: Buffer.from(artifact.bytes),
              byteLength: artifact.bytes.byteLength,
            },
          });
        }
        await transaction.lessonVideoScreen.deleteMany({ where: { lessonId: lesson.id } });
        if (lesson.screens.length) {
          await transaction.lessonVideoScreen.createMany({
            data: lesson.screens.map((screen, position) => ({
              id: screen.id,
              lessonId: lesson.id,
              position,
              state: screen,
            })),
          });
        }
        return { ...lesson, recordVersion: lesson.recordVersion + 1 };
      });
    },
    async beginModelAttempt(lesson, attempt) {
      return store.saveStageResult(
        beginLessonModelAttempt(lesson, LessonModelAttemptSchema.parse(attempt)),
      );
    },
    async saveModelAttemptResult(lesson, attemptId, result, artifact) {
      return store.saveStageResult(settleLessonModelAttempt(lesson, attemptId, result), artifact);
    },
    async claimNextLesson(now, claimId) {
      return transact(async (transaction) => {
        if (
          await transaction.lessonVideo.count({
            where: { status: LessonVideoStatus.RUNNING, leaseUntil: { gt: now } },
          })
        ) {
          return null;
        }
        const row = await transaction.lessonVideo.findFirst({
          where: {
            OR: [
              { status: LessonVideoStatus.QUEUED },
              { status: LessonVideoStatus.RUNNING, leaseUntil: { lte: now } },
            ],
          },
          orderBy: { createdAt: 'asc' },
          include: { screens: true },
        });
        if (!row) {
          return null;
        }
        const lesson = readLesson(row);
        const updated = await transaction.lessonVideo.update({
          where: { id: row.id },
          data: {
            claimId,
            leaseUntil: new Date(now.getTime() + lesson.settings.jobs.leaseMs),
            status: LessonVideoStatus.RUNNING,
            recordVersion: { increment: 1 },
          },
          include: { screens: true },
        });
        return readLesson(updated);
      });
    },
    async renewClaim(id, claimId, leaseUntil) {
      return (
        (
          await client.lessonVideo.updateMany({
            where: { id, claimId, status: LessonVideoStatus.RUNNING },
            data: { leaseUntil },
          })
        ).count === 1
      );
    },
    async readArtifact(lessonId, artifactId) {
      const row = await client.lessonVideoArtifact.findFirst({
        where: { id: artifactId, lessonId },
      });
      return row
        ? {
            id: row.id,
            lessonId,
            kind: z.enum(LessonArtifactKind).parse(row.kind),
            bytes: row.bytes,
          }
        : null;
    },
    async deleteLesson(lesson) {
      await transact(async (transaction) => {
        const result = await transaction.lessonVideo.deleteMany({
          where: { id: lesson.id, ownerId: lesson.ownerId, recordVersion: lesson.recordVersion },
        });
        if (result.count !== 1) {
          throw new LessonVideoError(LessonVideoFailure.STALE);
        }
      });
    },
    close: () => client.$disconnect(),
  };
  return store;
}
