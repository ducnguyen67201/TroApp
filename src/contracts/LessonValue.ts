import { z } from 'zod';

const LessonJsonSchema = z.json();
type LessonJson = z.infer<typeof LessonJsonSchema>;

function sortLessonJson(value: LessonJson): LessonJson {
  if (Array.isArray(value)) {
    return value.map(sortLessonJson);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortLessonJson(child)]),
    );
  }
  return value;
}

/** Preserves the lesson hash protocol: validate JSON, sort object keys recursively, retain array order. */
export function serializeLessonValue(value: unknown): string {
  return JSON.stringify(sortLessonJson(LessonJsonSchema.parse(value)));
}
