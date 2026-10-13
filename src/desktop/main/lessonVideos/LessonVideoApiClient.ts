import {
  LessonVideoCommandSchema,
  LessonVideoReplySchema,
  LessonVideoFailure,
  LessonLimits,
  type LessonVideoCommand,
  type LessonVideoReply,
} from '#contracts/LessonVideos.js';

/** Main attaches the account cookie; renderer receives only validated data or bounded media bytes. */
export class LessonVideoApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}
  async execute(command: LessonVideoCommand): Promise<LessonVideoReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return { kind: 'failed', code: LessonVideoFailure.FORBIDDEN };
    }
    try {
      const response = await this.request(`${this.baseUrl}/api/v1/lesson-videos`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(LessonVideoCommandSchema.parse(command)),
        signal: AbortSignal.timeout(30000),
      });
      const data: unknown = await response.json();
      if (this.readCookie() !== cookie) {
        return { kind: 'failed', code: LessonVideoFailure.FORBIDDEN };
      }
      return LessonVideoReplySchema.parse(data);
    } catch {
      return { kind: 'failed', code: LessonVideoFailure.UNAVAILABLE };
    }
  }
  async readMedia(id: string, artifactId: string): Promise<Uint8Array | null> {
    const cookie = this.readCookie();
    if (!cookie) {
      return null;
    }
    try {
      const response = await this.request(
        `${this.baseUrl}/api/v1/lesson-videos/${id}/artifacts/${artifactId}`,
        { headers: { cookie }, signal: AbortSignal.timeout(30000) },
      );
      if (!response.ok || !response.body) {
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          size += result.value.length;
          if (size > LessonLimits.VIDEO_BYTES) {
            return null;
          }
          chunks.push(result.value);
        }
      } finally {
        await reader.cancel();
      }
      return this.readCookie() === cookie ? Buffer.concat(chunks) : null;
    } catch {
      return null;
    }
  }
}
