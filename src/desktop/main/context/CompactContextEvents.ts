import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ContextEventKind, ContextLimits, type ContextEvent } from '#contracts/StudyContext.js';
import { StudentActivityKind, StudentPointSchema } from '#contracts/StudentActivity.js';

const snapshotVersion = 'local-activity-snapshot-v1';
const snapshotCharacters = Math.min(24_000, ContextLimits.SOURCE_CHARACTERS);
const excerptCharacters = 1800;
const InputSchema = z.object({
  kind: z.enum(StudentActivityKind),
  point: StudentPointSchema.nullable().optional(),
});

type Point = z.infer<typeof StudentPointSchema>;

interface EvidenceExcerpt {
  localEventId: string;
  kind: ContextEvent['kind'];
  resource: string;
  observedAt: string;
  text: string;
  limitation: string;
  textTruncated: boolean;
}

function readInput(text: string): z.infer<typeof InputSchema> | null {
  try {
    const raw: unknown = JSON.parse(text);
    const result = InputSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function roundPoint(point: Point): Point {
  return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
}

function sliceExcerpt(text: string): string {
  const excerpt = text.slice(0, excerptCharacters);
  const lastCode = excerpt.charCodeAt(excerpt.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? excerpt.slice(0, -1) : excerpt;
}

function hasSameEventContent(left: ContextEvent, right: ContextEvent): boolean {
  return (
    left.kind === right.kind &&
    left.resource === right.resource &&
    left.observedAt === right.observedAt &&
    left.text === right.text &&
    left.limitation === right.limitation
  );
}

/** Version 8 UUID carries a stable hash so retrying the same local evidence is idempotent. */
function createSnapshotId(events: readonly ContextEvent[], omittedEntries: number): string {
  const hash = createHash('sha256').update(snapshotVersion).update(String(omittedEntries));
  for (const event of events) {
    hash.update('\n').update(event.id);
  }
  const digest = hash.digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Create one bounded Ask snapshot without an AI call. Full records stay local when secure storage succeeds; memory fallback can be lost on restart;
 * remote context contains action counts and selected evidence, never a complete activity replay.
 * Callers validate events at capture/storage boundaries and supply one stable upload snapshot. */
export function compactContextEvents(
  events: readonly ContextEvent[],
  omittedEntries = 0,
): ContextEvent[] {
  if (!Number.isSafeInteger(omittedEntries) || omittedEntries < 0) {
    throw new RangeError('Omitted local segment count must be a nonnegative safe integer.');
  }
  const unique = new Map<string, ContextEvent>();
  for (const event of events) {
    const previous = unique.get(event.id);
    if (previous && !hasSameEventContent(previous, event)) {
      throw new Error('Conflicting local context event identity.');
    }
    unique.set(event.id, event);
  }
  const ordered = [...unique.values()].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id),
  );
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) {
    return [];
  }

  const eventCounts = {
    [ContextEventKind.RESOURCE]: 0,
    [ContextEventKind.OBSERVATION]: 0,
    [ContextEventKind.INPUT]: 0,
    [ContextEventKind.ATTEMPT]: 0,
    [ContextEventKind.RESULT]: 0,
    [ContextEventKind.USER_MESSAGE]: 0,
  };
  const inputCounts = {
    [StudentActivityKind.PRESS]: 0,
    [StudentActivityKind.RELEASE]: 0,
    [StudentActivityKind.DRAG]: 0,
    [StudentActivityKind.KEY]: 0,
    [StudentActivityKind.SCROLL]: 0,
    unknown: 0,
  };
  let firstPoint: Point | null = null;
  let lastPoint: Point | null = null;
  const evidence: ContextEvent[] = [];
  for (const event of ordered) {
    eventCounts[event.kind] += 1;
    if (event.kind !== ContextEventKind.INPUT) {
      evidence.push(event);
      continue;
    }
    const input = readInput(event.text);
    if (!input) {
      inputCounts.unknown += 1;
      continue;
    }
    inputCounts[input.kind] += 1;
    if (input.point) {
      const point = roundPoint(input.point);
      firstPoint ??= point;
      lastPoint = point;
    }
  }

  const excerpts: EvidenceExcerpt[] = [];
  const snapshot = {
    version: snapshotVersion,
    firstObservedAt: first.observedAt,
    lastObservedAt: last.observedAt,
    eventCount: ordered.length,
    omittedLocalSegments: omittedEntries,
    eventCounts,
    physicalInputs: {
      counts: inputCounts,
      firstPoint,
      lastPoint,
      limitation:
        'Counts and coarse first/last pointer positions only. Targets, exact trajectories and app acceptance are unknown.',
    },
    evidenceEventCount: evidence.length,
    omittedEvidenceEvents: evidence.length,
    truncatedEvidenceExcerpts: 0,
    excerpts,
    coverage:
      'Selected local activity only. Excerpts may be truncated and earlier observations omitted. Omitted local segment counts may include unread log ranges, not an exact count of missing events. Local event IDs identify local records, not remotely readable sources. Full records remain in the encrypted local journal when secure storage succeeds, until local retention expires. Memory-only fallback records may be lost on app restart. Input counts are attempts, not proof of task completion or learning.',
  };
  for (const event of [...evidence].reverse()) {
    const text = sliceExcerpt(event.text);
    const excerpt: EvidenceExcerpt = {
      localEventId: event.id,
      kind: event.kind,
      resource: event.resource,
      observedAt: event.observedAt,
      text,
      limitation: event.limitation,
      textTruncated: text.length < event.text.length,
    };
    snapshot.excerpts.unshift(excerpt);
    snapshot.omittedEvidenceEvents -= 1;
    if (excerpt.textTruncated) {
      snapshot.truncatedEvidenceExcerpts += 1;
    }
    if (JSON.stringify(snapshot).length > snapshotCharacters) {
      snapshot.excerpts.shift();
      snapshot.omittedEvidenceEvents += 1;
      if (excerpt.textTruncated) {
        snapshot.truncatedEvidenceExcerpts -= 1;
      }
      break;
    }
  }

  return [
    {
      id: createSnapshotId(ordered, omittedEntries),
      kind: ContextEventKind.OBSERVATION,
      resource: 'local-activity-snapshot',
      observedAt: last.observedAt,
      text: JSON.stringify(snapshot),
      limitation:
        'Compact Ask snapshot: action counts and selected text excerpts. Original records stay local when storage succeeds; memory-only fallback may be lost on restart. Omitted/truncated evidence is counted; exact click targets, app acceptance and student understanding are unverified.',
    },
  ];
}
