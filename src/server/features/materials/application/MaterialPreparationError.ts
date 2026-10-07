import type { MaterialStageInput } from './MaterialGeneration.js';

/** Safe failure categories; source text and provider error bodies never enter logs. */
export const MaterialPreparationReason = {
  UNKNOWN: 'unknown',
  GENERATION_LIMIT: 'generation_limit',
  STALE_STAGE: 'stale_stage',
  EXTRACTION_LIMIT: 'extraction_limit',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PROVIDER_REQUEST_FAILED: 'provider_request_failed',
  PROVIDER_TIMEOUT: 'provider_timeout',
  INVALID_JSON: 'invalid_json',
  INVALID_DRAFT: 'invalid_draft',
  INCOMPLETE_RESPONSE: 'incomplete_response',
  INVALID_SOURCE_REFERENCES: 'invalid_source_references',
  SOURCE_CHANGED: 'source_changed',
  CITATION_REPAIR_CHANGED_CONTENT: 'citation_repair_changed_content',
} as const;

type MaterialPreparationReason =
  (typeof MaterialPreparationReason)[keyof typeof MaterialPreparationReason];

/** Diagnostic vocabulary is separate from preparation decisions and does not change retries. */
export const MaterialProviderOperation = {
  COUNT_INPUT: 'count_input',
  GENERATE: 'generate',
} as const;

export type MaterialProviderOperation =
  (typeof MaterialProviderOperation)[keyof typeof MaterialProviderOperation];

export const MaterialProviderErrorKind = {
  TIMEOUT: 'timeout',
  CONNECTION: 'connection',
  ABORT: 'abort',
  HTTP: 'http',
  VALIDATION: 'validation',
  JSON: 'json',
  PREPARATION: 'preparation',
  UNKNOWN: 'unknown',
} as const;

export type MaterialProviderErrorKind =
  (typeof MaterialProviderErrorKind)[keyof typeof MaterialProviderErrorKind];

export const MaterialRequestAbortKind = {
  TIMEOUT: 'timeout',
  ABORT: 'abort',
  OTHER: 'other',
} as const;

export type MaterialRequestAbortKind =
  (typeof MaterialRequestAbortKind)[keyof typeof MaterialRequestAbortKind];

export const MaterialReferenceKind = { PAGE: 'page', PASSAGE: 'passage' } as const;

export type MaterialReferenceKind =
  (typeof MaterialReferenceKind)[keyof typeof MaterialReferenceKind];

export const MaterialReferenceFailure = {
  MISSING: 'missing_required_reference',
  WRONG_KIND: 'wrong_reference_kind',
  NOT_ALLOWED: 'reference_not_in_allowed_set',
} as const;

export interface MaterialReferenceIssue {
  path: string;
  reason: (typeof MaterialReferenceFailure)[keyof typeof MaterialReferenceFailure];
  expectedKind: MaterialReferenceKind;
  actualKind?: MaterialReferenceKind;
  sourceId?: string;
  allowedReferenceCount: number;
}

export interface MaterialPreparationDiagnostic {
  reason: MaterialPreparationReason;
  operation?: MaterialProviderOperation;
  generationStage?: MaterialStageInput['kind'];
  providerErrorKind?: MaterialProviderErrorKind;
  networkCauseCode?: string;
  signalAborted?: boolean;
  abortKind?: MaterialRequestAbortKind;
  providerDurationMs?: number;
  usedInputTokens?: number;
  usedOutputTokens?: number;
  reasoningTokens?: number;
  httpStatus?: number;
  requestId?: string;
  responseStatus?: string;
  incompleteReason?: string;
  validationIssueCount?: number;
  stageKey?: string;
  materialId?: string;
  referenceIssueCount?: number;
  referenceIssues?: MaterialReferenceIssue[];
  referenceIssuesTruncated?: boolean;
  allowedPageCount?: number;
  allowedPassageCount?: number;
  citationRepair?: boolean;
}

/** Owned explanations only: never interpolate source content or provider error messages. */
export function describeMaterialPreparationFailure(
  diagnostic: MaterialPreparationDiagnostic,
): string {
  switch (diagnostic.reason) {
    case MaterialPreparationReason.INVALID_SOURCE_REFERENCES:
      return describeMaterialReferenceFailure(diagnostic.referenceIssues?.[0]);
    case MaterialPreparationReason.CITATION_REPAIR_CHANGED_CONTENT:
      return 'Citation repair changed lesson content. The repaired draft was rejected.';
    case MaterialPreparationReason.INCOMPLETE_RESPONSE:
      return 'The provider returned an unfinished response. Check incompleteReason and output token usage.';
    case MaterialPreparationReason.PROVIDER_TIMEOUT:
      return 'The provider request exceeded its timeout.';
    case MaterialPreparationReason.PROVIDER_REQUEST_FAILED:
      return 'The provider request failed. Check providerErrorKind, HTTP status and network cause.';
    case MaterialPreparationReason.GENERATION_LIMIT:
      return 'Preparation exceeded a configured input, output or call budget.';
    case MaterialPreparationReason.INVALID_DRAFT:
      return 'The generated draft failed schema validation.';
    case MaterialPreparationReason.INVALID_JSON:
      return 'The generated response could not be parsed as JSON.';
    case MaterialPreparationReason.STALE_STAGE:
    case MaterialPreparationReason.SOURCE_CHANGED:
      return 'The preparation job or its source version changed before the result could be saved.';
    case MaterialPreparationReason.EXTRACTION_LIMIT:
      return 'The source extraction exceeded a supported limit.';
    case MaterialPreparationReason.PROVIDER_UNAVAILABLE:
      return 'Material generation is unavailable on this backend.';
    default:
      return 'Material preparation failed without a classified cause.';
  }
}

function describeMaterialReferenceFailure(issue: MaterialReferenceIssue | undefined): string {
  if (!issue) {
    return 'AI output was rejected because its citations do not match the allowed source references.';
  }
  switch (issue.reason) {
    case MaterialReferenceFailure.WRONG_KIND:
      return `AI output used the wrong source ID kind at ${issue.path}. This field requires ${issue.expectedKind} IDs; it received a ${issue.actualKind ?? 'different'} ID.`;
    case MaterialReferenceFailure.MISSING:
      return `AI output omitted a required ${issue.expectedKind} citation at ${issue.path}.`;
    case MaterialReferenceFailure.NOT_ALLOWED:
      return `AI output cited an ID that was not in the allowed ${issue.expectedKind} references at ${issue.path}.`;
  }
}

export class MaterialPreparationError extends Error {
  constructor(readonly diagnostic: MaterialPreparationDiagnostic) {
    super(diagnostic.reason);
    this.name = 'MaterialPreparationError';
  }
}
