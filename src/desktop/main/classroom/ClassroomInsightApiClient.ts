import {
  ClassroomInsightCommandSchema,
  ClassroomInsightReplySchema,
  InsightFailure,
  type ClassroomInsightCommand,
  type ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';

/** Authenticated insight transport. Private credentials and response validation stay in main. */
export class ClassroomInsightApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  async execute(
    command: ClassroomInsightCommand,
    signal?: AbortSignal,
  ): Promise<ClassroomInsightReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: InsightFailure.FORBIDDEN };
    }
    try {
      const timeout = AbortSignal.timeout(30000);
      const response = await this.request(`${this.baseUrl}/api/v1/classroom/insights`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(ClassroomInsightCommandSchema.parse(command)),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const raw: unknown = await response.json();
      if (cookie !== this.readCookie() || signal?.aborted) {
        return { kind: 'failed', code: InsightFailure.STALE };
      }
      return ClassroomInsightReplySchema.parse(raw);
    } catch {
      return {
        kind: 'failed',
        code: signal?.aborted ? InsightFailure.STALE : InsightFailure.UNAVAILABLE,
      };
    }
  }
}
