import type { GuidedLessonStore } from './GuidedLessonStore.js';
import {
  LessonReservationState,
  type LessonBudget,
  type LessonRecord,
  type LessonReservation,
} from './LessonState.js';
import { LessonError, LessonFailure } from './LessonFailure.js';

export const LessonPolicy = {
  RUN_ATTEMPTS: 7,
  DAY_RUNS: 5,
  RUN_SPEECH_CHARACTERS: 6000,
  RUN_SPEECH_ATTEMPTS: 24,
  RUN_RENDER_RETRIES: 1,
  MAX_ARTIFACT_BYTES: 16777216,
  RUN_ARTIFACT_BYTES: 167772160,
  LEASE_MS: 60000,
  HEARTBEAT_MS: 15000,
  DEADLINE_MS: 600000,
  GRAPHICS_DEADLINE_MS: 1800000,
} as const;

export const StageAllowance = {
  drafting: { input: 8000, output: 6000 },
  reviewingContent: { input: 10000, output: 3000 },
  repairingContent: { input: 10000, output: 4000 },
  recheckingContent: { input: 10000, output: 2000 },
  reviewingVisuals: { input: 20000, output: 2000 },
  repairingVisuals: { input: 10000, output: 2000 },
  recheckingVisuals: { input: 20000, output: 2000 },
} as const;

export function createLessonBudget(id: string): LessonBudget {
  return { id, version: 0, runs: 0, helpRequests: 0, helpTimes: [], reservations: [] };
}

export async function admitLessonRun(
  store: GuidedLessonStore,
  teacherId: string,
  now: Date,
): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const id = `${teacherId}:${day}`;
  const budget = (await store.readBudget(id)) ?? createLessonBudget(id);
  if (
    budget.runs >= LessonPolicy.DAY_RUNS ||
    budget.reservations.some(
      (item) =>
        item.state === LessonReservationState.UNCERTAIN ||
        item.state === LessonReservationState.DISPATCHED,
    )
  ) {
    throw new LessonError(LessonFailure.BUDGET);
  }
  await store.saveBudget(
    { ...budget, version: budget.version + 1, runs: budget.runs + 1 },
    budget.version,
  );
  return day;
}

/** Tracks attempts for measurement. Uncertain paid outcomes block replay, not measured token totals. */
export async function reserveLessonAttempt(
  store: GuidedLessonStore,
  record: LessonRecord,
  reservation: LessonReservation,
): Promise<void> {
  if (!record.run) {
    throw new LessonError(LessonFailure.STALE);
  }
  const id = `${record.teacherId}:${record.run.day}`;
  const budget = (await store.readBudget(id)) ?? createLessonBudget(id);
  if (budget.reservations.some((item) => item.state === LessonReservationState.UNCERTAIN)) {
    throw new LessonError(LessonFailure.BUDGET);
  }
  await store.saveBudget(
    { ...budget, version: budget.version + 1, reservations: [...budget.reservations, reservation] },
    budget.version,
  );
}

/** Settles usage even when a late provider result no longer owns the mutable draft. */
export async function settleLessonAttempt(
  store: GuidedLessonStore,
  teacherId: string,
  day: string,
  attemptId: string,
  usage: { inputTokens: number; outputTokens: number } | null,
): Promise<void> {
  const id = `${teacherId}:${day}`;
  const budget = await store.readBudget(id);
  const reservation = budget?.reservations.find((item) => item.id === attemptId);
  if (!budget || !reservation || reservation.state === LessonReservationState.SETTLED) {
    return;
  }
  const valid =
    usage &&
    Number.isSafeInteger(usage.inputTokens) &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.inputTokens >= 0 &&
    usage.outputTokens >= 0;
  await store.saveBudget(
    {
      ...budget,
      version: budget.version + 1,
      reservations: budget.reservations.map((item) =>
        item.id === attemptId
          ? {
              ...item,
              state: valid ? LessonReservationState.SETTLED : LessonReservationState.UNCERTAIN,
              actualInput: valid ? usage.inputTokens : null,
              actualOutput: valid ? usage.outputTokens : null,
            }
          : item,
      ),
    },
    budget.version,
  );
}
