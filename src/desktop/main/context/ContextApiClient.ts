import {
  ContextCommandSchema,
  ContextFailure,
  ContextReplySchema,
  type ContextCommand,
  type ContextReply,
} from '#contracts/StudyContext.js';

/** Main owns the cookie; renderer and task workers receive only validated evidence. */
export class ContextApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  async execute(command: ContextCommand, signal?: AbortSignal): Promise<ContextReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: ContextFailure.UNAUTHORIZED };
    }
    try {
      const response = await this.request(`${this.baseUrl}/api/v1/context/command`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(ContextCommandSchema.parse(command)),
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(command.kind === 'search' ? 25_000 : 3000),
            ])
          : AbortSignal.timeout(command.kind === 'search' ? 25_000 : 3000),
      });
      const raw: unknown = await response.json();
      return ContextReplySchema.parse(raw);
    } catch {
      return { kind: 'failed', code: ContextFailure.UNAVAILABLE };
    }
  }
}
