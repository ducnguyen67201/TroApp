import {
  PracticeCommandSchema,
  PracticeReplySchema,
  PracticeFailure,
  type PracticeCommand,
  type PracticeReply,
} from '#contracts/PracticeCheck.js';
/** Main alone attaches credentials; a changed account fences every reply. */
export class PracticeCheckApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}
  async execute(command: PracticeCommand): Promise<PracticeReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: PracticeFailure.FORBIDDEN };
    }
    try {
      const response = await this.request(`${this.baseUrl}/api/v1/classroom/practice`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(PracticeCommandSchema.parse(command)),
        signal: AbortSignal.timeout(70000),
      });
      const raw: unknown = await response.json();
      if (cookie !== this.readCookie()) {
        return { kind: 'failed', code: PracticeFailure.STALE };
      }
      return PracticeReplySchema.parse(raw);
    } catch {
      return { kind: 'failed', code: PracticeFailure.UNAVAILABLE };
    }
  }
}
