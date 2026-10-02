import { z } from 'zod';
import type { Microphone } from './Microphones.js';

export const microphoneRankingStorageKey = 'tro.desktop.microphoneRanking';

const MicrophoneRankingSchema = z
  .array(z.string().min(1).max(512))
  .max(64)
  .refine(
    (ids) =>
      new Set(ids).size === ids.length &&
      !ids.includes('default') &&
      !ids.includes('communications'),
  );

export function readSavedMicrophoneRanking(): string[] {
  try {
    const raw: unknown = JSON.parse(
      window.localStorage.getItem(microphoneRankingStorageKey) ?? '[]',
    );
    const parsed = MicrophoneRankingSchema.safeParse(raw);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Missing IDs retain their preference; unranked inputs keep their hint-based order. */
export function orderMicrophones(
  microphones: readonly Microphone[],
  ranking: readonly string[],
): Microphone[] {
  const positions = new Map(ranking.map((deviceId, index) => [deviceId, index]));
  return [...microphones].sort(
    (first, second) =>
      (positions.get(first.deviceId) ?? ranking.length) -
      (positions.get(second.deviceId) ?? ranking.length),
  );
}

/** Reorder connected devices without dropping preferences for temporarily absent hardware. */
export function moveMicrophone(
  microphones: readonly Microphone[],
  ranking: readonly string[],
  deviceId: string,
  direction: -1 | 1,
): string[] {
  const ids = orderMicrophones(microphones, ranking).map((microphone) => microphone.deviceId);
  const index = ids.indexOf(deviceId);
  const neighbor = ids[index + direction];
  if (index < 0 || !neighbor) {
    return [...ranking];
  }
  ids[index] = neighbor;
  ids[index + direction] = deviceId;
  const connected = new Set(ids);
  const updated = [...ids, ...ranking.filter((id) => !connected.has(id))].slice(0, 64);
  return MicrophoneRankingSchema.parse(updated);
}
