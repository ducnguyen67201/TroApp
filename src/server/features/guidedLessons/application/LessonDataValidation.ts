import { z } from 'zod';

export const LessonDataSource = {
  CLASS: 'class',
  PUBLICATION: 'publication',
  LESSON: 'lesson',
  RELEASE: 'release',
  PROGRESS: 'progress',
  REQUEST: 'request',
  NOTE: 'note',
  BUDGET: 'budget',
  RECEIPT: 'receipt',
  ARTIFACT: 'artifact',
} as const;

export type LessonDataSource = (typeof LessonDataSource)[keyof typeof LessonDataSource];

const validationSources = new WeakMap<z.ZodError, LessonDataSource>();

/** Attach the owning storage boundary without changing the error or retaining raw stored data. */
export function parseLessonData<T>(
  schema: z.ZodType<T>,
  input: unknown,
  source: LessonDataSource,
): T {
  try {
    return schema.parse(input);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      validationSources.set(error, source);
    }
    throw error;
  }
}

export function readLessonDataSource(error: z.ZodError): LessonDataSource | null {
  return validationSources.get(error) ?? null;
}
