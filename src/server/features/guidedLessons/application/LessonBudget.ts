import type { GuidedLessonStore } from './GuidedLessonStore.js';
import {
  LessonReservationState,
  type LessonBudget,
  type LessonRecord,
  type LessonReservation,
} from './LessonState.js';
import { LessonError, LessonFailure } from './LessonFailure.js';

export const LessonPolicy = {
  RUN_INPUT: 90000,
  RUN_OUTPUT: 30000,
  RUN_ATTEMPTS: 7,
  DAY_RUNS: 5,
  DAY_INPUT: 300000,
  DAY_OUTPUT: 100000,
  DAY_SPEECH_CHARACTERS: 20000,
  RUN_SPEECH_CHARACTERS: 6000,
  RUN_SPEECH_ATTEMPTS: 24,
  MAX_ARTIFACT_BYTES: 16777216,
  RUN_ARTIFACT_BYTES: 167772160,
  LEASE_MS: 60000,
  HEARTBEAT_MS: 15000,
  DEADLINE_MS: 600000,
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

function countReserved(budget: LessonBudget): {
  input: number;
  output: number;
  characters: number;
} {
  return budget.reservations.reduce(
    (total, item) => ({
      input:
        total.input +
        (item.state === LessonReservationState.SETTLED
          ? (item.actualInput ?? item.input)
          : item.input),
      output:
        total.output +
        (item.state === LessonReservationState.SETTLED
          ? (item.actualOutput ?? item.output)
          : item.output),
      characters: total.characters + item.speechCharacters,
    }),
    { input: 0, output: 0, characters: 0 },
  );
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

/** Called only in the stage-claim transaction. Unknown usage remains conservatively reserved. */
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
  const totals = countReserved(budget);
  if (
    budget.reservations.some((item) => item.state === LessonReservationState.UNCERTAIN) ||
    totals.input + reservation.input > LessonPolicy.DAY_INPUT ||
    totals.output + reservation.output > LessonPolicy.DAY_OUTPUT ||
    totals.characters + reservation.speechCharacters > LessonPolicy.DAY_SPEECH_CHARACTERS
  ) {
    throw new LessonError(LessonFailure.BUDGET);
  }
  const runItems = budget.reservations.filter((item) => item.runId === record.run?.id);
  const runBudget = countReserved({ ...budget, reservations: runItems });
  if (
    runBudget.input + reservation.input > LessonPolicy.RUN_INPUT ||
    runBudget.output + reservation.output > LessonPolicy.RUN_OUTPUT ||
    runBudget.characters + reservation.speechCharacters > LessonPolicy.RUN_SPEECH_CHARACTERS
  ) {
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
