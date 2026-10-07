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
} as const;

type MaterialPreparationReason =
  (typeof MaterialPreparationReason)[keyof typeof MaterialPreparationReason];

export interface MaterialPreparationDiagnostic {
  reason: MaterialPreparationReason;
  httpStatus?: number;
  requestId?: string;
  responseStatus?: string;
  incompleteReason?: string;
  validationIssueCount?: number;
}

export class MaterialPreparationError extends Error {
  constructor(readonly diagnostic: MaterialPreparationDiagnostic) {
    super(diagnostic.reason);
    this.name = 'MaterialPreparationError';
  }
}
