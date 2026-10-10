import { createHash } from 'node:crypto';
import {
  GuidedLessonArtifactReplySchema,
  GuidedLessonArtifactRequestSchema,
  GuidedLessonCommandSchema,
  GuidedLessonReadRequestSchema,
  GuidedLessonReplySchema,
  GuidedLessonFailure,
  type GuidedLessonArtifactReply,
  type GuidedLessonArtifactRequest,
  type GuidedLessonCommand,
  type GuidedLessonReadRequest,
  type GuidedLessonReply,
} from '#contracts/GuidedLessons.js';

const maximumArtifactBytes = 16 * 1024 * 1024;

/** Cookies and bounded binary downloads stay in main. Account changes fence every reply. */
export class GuidedLessonApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readCookie: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  read(request: GuidedLessonReadRequest): Promise<GuidedLessonReply> {
    return this.send('read', GuidedLessonReadRequestSchema.parse(request));
  }

  command(command: GuidedLessonCommand): Promise<GuidedLessonReply> {
    return this.send('command', GuidedLessonCommandSchema.parse(command));
  }

  async readArtifact(raw: GuidedLessonArtifactRequest): Promise<GuidedLessonArtifactReply> {
    const request = GuidedLessonArtifactRequestSchema.parse(raw);
    const cookie = this.readCookie();
    if (!cookie) {
      return failure(GuidedLessonFailure.UNAUTHORIZED);
    }
    try {
      const query = request.releaseId ? `?releaseId=${encodeURIComponent(request.releaseId)}` : '';
      const url = `${this.baseUrl}/api/v1/guided-lessons/${encodeURIComponent(request.classId)}/${encodeURIComponent(request.lessonId)}/artifacts/${encodeURIComponent(request.artifactId)}${query}`;
      const response = await this.request(url, {
        headers: { cookie },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return failure(
          response.status === 403
            ? GuidedLessonFailure.UNAUTHORIZED
            : GuidedLessonFailure.UNAVAILABLE,
        );
      }
      const declared = Number(response.headers.get('content-length'));
      if (
        !Number.isSafeInteger(declared) ||
        declared <= 0 ||
        declared > maximumArtifactBytes ||
        !response.body
      ) {
        await response.body?.cancel();
        return failure(GuidedLessonFailure.UNAVAILABLE);
      }
      const body = response.body;
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        let chunk = await reader.read();
        while (!chunk.done) {
          size += chunk.value.byteLength;
          if (size > maximumArtifactBytes || size > declared) {
            await reader.cancel();
            return failure(GuidedLessonFailure.UNAVAILABLE);
          }
          chunks.push(chunk.value);
          chunk = await reader.read();
        }
      } finally {
        reader.releaseLock();
      }
      if (size !== declared || this.readCookie() !== cookie) {
        return failure(GuidedLessonFailure.UNAUTHORIZED);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== response.headers.get('x-artifact-digest')) {
        return failure(GuidedLessonFailure.UNAVAILABLE);
      }
      return GuidedLessonArtifactReplySchema.parse({
        kind: 'artifact',
        artifactId: request.artifactId,
        mimeType: response.headers.get('content-type')?.split(';')[0],
        bytes,
        digest,
      });
    } catch {
      return failure(GuidedLessonFailure.UNAVAILABLE);
    }
  }

  private async send(
    path: 'read' | 'command',
    value: GuidedLessonReadRequest | GuidedLessonCommand,
  ): Promise<GuidedLessonReply> {
    const cookie = this.readCookie();
    if (!cookie) {
      return failure(GuidedLessonFailure.UNAUTHORIZED);
    }
    try {
      const response = await this.request(`${this.baseUrl}/api/v1/guided-lessons/${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(value),
        signal: AbortSignal.timeout(30_000),
      });
      const raw: unknown = await response.json();
      if (this.readCookie() !== cookie) {
        return failure(GuidedLessonFailure.UNAUTHORIZED);
      }
      return GuidedLessonReplySchema.parse(raw);
    } catch {
      return failure(GuidedLessonFailure.UNAVAILABLE);
    }
  }
}

export function failure(code: GuidedLessonFailure): {
  kind: 'failed';
  code: GuidedLessonFailure;
  message: string;
} {
  return { kind: 'failed', code, message: 'The guided lesson request could not be completed.' };
}
