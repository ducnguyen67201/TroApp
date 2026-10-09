import { z } from 'zod';
import {
  InsightFailure,
  InsightRevisionSchema,
  InsightWindowSchema,
  type InsightWindow,
} from '#contracts/ClassroomInsights.js';
import { ClassroomInsightError } from '../domain/ClassroomInsightError.js';

export interface InsightCursorScope {
  classId: string;
  studentId: string | null;
  window: InsightWindow;
  cutoff: string;
  privacyRevision: string;
}

const SourceCursorSchema = z.strictObject({
  version: z.literal(1),
  position: InsightRevisionSchema,
  classId: z.uuid(),
  studentId: z.string().min(1).max(200).nullable(),
  window: InsightWindowSchema,
  cutoff: InsightRevisionSchema,
  privacyRevision: InsightRevisionSchema,
});

/** A cursor is a position in one authorized snapshot, never a grant of access. */
export function encodeSourceCursor(position: string, scope: InsightCursorScope): string {
  const cursor = SourceCursorSchema.parse({ version: 1, position, ...scope });
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeSourceCursor(cursor: string | undefined, scope: InsightCursorScope): string {
  if (cursor === undefined) {
    return '0';
  }
  try {
    if (cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
    const raw: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = SourceCursorSchema.parse(raw);
    if (
      parsed.classId !== scope.classId ||
      parsed.studentId !== scope.studentId ||
      parsed.cutoff !== scope.cutoff ||
      parsed.privacyRevision !== scope.privacyRevision ||
      parsed.window.from !== scope.window.from ||
      parsed.window.to !== scope.window.to ||
      parsed.window.timezone !== scope.window.timezone ||
      BigInt(parsed.position) > BigInt(scope.cutoff)
    ) {
      throw new ClassroomInsightError(InsightFailure.STALE);
    }
    return parsed.position;
  } catch (error: unknown) {
    if (error instanceof ClassroomInsightError) {
      throw error;
    }
    throw new ClassroomInsightError(InsightFailure.INVALID);
  }
}
