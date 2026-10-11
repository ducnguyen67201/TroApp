import { z } from 'zod';
import {
  GuidedLessonAction,
  GuidedLessonReadAction,
  type GuidedLessonCommand,
  type GuidedLessonReadRequest,
} from '#contracts/GuidedLessons.js';
import { LessonError, type LessonFailure } from '../application/LessonFailure.js';
import {
  readLessonDataSource,
  type LessonDataSource,
} from '../application/LessonDataValidation.js';

export const LessonRequestStage = {
  REQUEST: 'request',
  SERVICE: 'service',
  RESPONSE: 'response',
} as const;

export type LessonRequestStage = (typeof LessonRequestStage)[keyof typeof LessonRequestStage];

const LessonRequestErrorKind = {
  VALIDATION: 'validation',
  LESSON: 'lesson',
  UNEXPECTED: 'unexpected',
} as const;

const DiagnosticLimits = { ISSUES: 8, PATH_SEGMENTS: 12, VISITED_ISSUES: 32 } as const;
const RequestIdFields = ['classId', 'lessonId', 'releaseId', 'artifactId', 'commandId'] as const;
const ReadActionSchema = z.object({ action: z.enum(GuidedLessonReadAction) });
const CommandActionSchema = z.object({ action: z.enum(GuidedLessonAction) });
const UuidSchema = z.uuid();

/* Only schema-owned names may enter logs: record/map keys can contain private text. */
const SchemaFields = new Set([
  'action',
  'kind',
  'id',
  'classId',
  'teacherId',
  'studentId',
  'lessonId',
  'releaseId',
  'artifactId',
  'commandId',
  'courseId',
  'courseRevisionId',
  'revisionId',
  'schemaVersion',
  'version',
  'expectedVersion',
  'title',
  'name',
  'language',
  'status',
  'error',
  'updatedAt',
  'createdAt',
  'approvedAt',
  'releasedAt',
  'available',
  'draft',
  'document',
  'documents',
  'sections',
  'pages',
  'sources',
  'revisions',
  'passages',
  'passageIds',
  'sourcePageIds',
  'passageId',
  'materialId',
  'publicationId',
  'ownerSourceId',
  'correctsPassageIds',
  'pageId',
  'sourceUnitId',
  'sourceDigest',
  'textDigest',
  'digest',
  'text',
  'extractedText',
  'teacherNote',
  'sourceRefs',
  'startOffset',
  'endOffset',
  'sequence',
  'start',
  'end',
  'location',
  'heading',
  'warnings',
  'topics',
  'input',
  'plan',
  'record',
  'run',
  'progress',
  'notes',
  'requests',
  'classes',
  'lessons',
  'contentHash',
  'review',
  'visualReview',
  'manifest',
  'scriptApproved',
  'previewApproved',
  'usage',
  'scenes',
  'sceneId',
  'phase',
  'checkpointId',
  'checkpoints',
  'codeBlocks',
  'traces',
  'assets',
  'templates',
  'teacherAnswerKeys',
  'teacherInstructions',
  'codeApproval',
  'practiceCodeApproval',
  'code',
  'lines',
  'lineId',
  'traceId',
  'codeBlockId',
  'anchor',
  'noteId',
  'frame',
  'reply',
  'result',
  'resolution',
  'budget',
  'receipt',
  'bytes',
  'mimeType',
  'size',
  'durationMs',
  'byteLength',
  'speech',
  'objective',
  'audience',
  'conceptId',
  'targetDurationSeconds',
  'sourcePacketHash',
  'requestId',
  'approvedBy',
  'collectionId',
]);

interface ValidationIssueDiagnostic {
  code: z.core.$ZodIssue['code'];
  path: (string | number)[];
  pathTruncated: boolean;
  minimum?: number;
  maximum?: number;
  inclusive?: boolean;
}

interface LessonRequestErrorDiagnostic {
  errorKind: (typeof LessonRequestErrorKind)[keyof typeof LessonRequestErrorKind];
  reason?: LessonFailure;
  validation?: {
    source: LessonDataSource | LessonRequestStage;
    issueCount: number;
    issues: ValidationIssueDiagnostic[];
    issuesTruncated: boolean;
  };
}

type LessonRequestContext = Partial<Record<(typeof RequestIdFields)[number], string>> & {
  action: GuidedLessonCommand['action'] | GuidedLessonReadRequest['action'] | null;
};

function describeValidationIssue(
  issue: z.core.$ZodIssue,
  path: readonly PropertyKey[],
): ValidationIssueDiagnostic {
  const diagnostic: ValidationIssueDiagnostic = {
    code: issue.code,
    path: path.slice(0, DiagnosticLimits.PATH_SEGMENTS).map((segment) => {
      if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
        return segment;
      }
      return typeof segment === 'string' && SchemaFields.has(segment) ? segment : '[redacted]';
    }),
    pathTruncated: path.length > DiagnosticLimits.PATH_SEGMENTS,
  };
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    const limit = issue.code === 'too_big' ? issue.maximum : issue.minimum;
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      if (issue.code === 'too_big') {
        diagnostic.maximum = limit;
      } else {
        diagnostic.minimum = limit;
      }
    }
    if (typeof issue.inclusive === 'boolean') {
      diagnostic.inclusive = issue.inclusive;
    }
  }
  return diagnostic;
}

/** Failure metadata only: never serialize Zod messages, inputs, enum values or unknown keys. */
export function describeLessonRequestError(
  error: unknown,
  failureStage: LessonRequestStage,
): LessonRequestErrorDiagnostic {
  if (!(error instanceof z.ZodError)) {
    return {
      errorKind:
        error instanceof LessonError
          ? LessonRequestErrorKind.LESSON
          : LessonRequestErrorKind.UNEXPECTED,
      ...(error instanceof LessonError ? { reason: error.code } : {}),
    };
  }
  const issues: ValidationIssueDiagnostic[] = [];
  let visited = 0;
  let issuesTruncated = false;

  function appendIssues(nested: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]): void {
    for (const issue of nested) {
      if (issues.length >= DiagnosticLimits.ISSUES || visited >= DiagnosticLimits.VISITED_ISSUES) {
        issuesTruncated = true;
        return;
      }
      visited += 1;
      const path = [...prefix, ...issue.path];
      issues.push(describeValidationIssue(issue, path));
      if (issue.code === 'invalid_union') {
        for (const branch of issue.errors) {
          appendIssues(branch, path);
          if (issuesTruncated) {
            return;
          }
        }
      } else if (issue.code === 'invalid_key' || issue.code === 'invalid_element') {
        appendIssues(issue.issues, path);
      }
    }
  }

  appendIssues(error.issues, []);
  return {
    errorKind: LessonRequestErrorKind.VALIDATION,
    validation: {
      source: readLessonDataSource(error) ?? failureStage,
      issueCount: error.issues.length,
      issues,
      issuesTruncated,
    },
  };
}

export function readLessonRequestContext(
  input: unknown,
  stage: 'read' | 'command' | 'artifact',
): LessonRequestContext {
  const parsedAction =
    stage === 'read'
      ? ReadActionSchema.safeParse(input)
      : stage === 'command'
        ? CommandActionSchema.safeParse(input)
        : null;
  const identifiers: Partial<Record<(typeof RequestIdFields)[number], string>> = {};
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    for (const field of RequestIdFields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      const value: unknown = descriptor?.value;
      const parsed = UuidSchema.safeParse(value);
      if (parsed.success) {
        identifiers[field] = parsed.data;
      }
    }
  }
  return { action: parsedAction?.success ? parsedAction.data.action : null, ...identifiers };
}
