import { Gaxios } from 'gaxios';
import {
  LessonRendererHealthSchema,
  LessonRenderReplySchema,
  type LessonRenderRequest,
} from '#contracts/LessonRenderProtocol.js';
import { LessonLimits } from '#contracts/LessonVideos.js';
import type { LessonRenderer } from '../application/LessonVideoPorts.js';

/** The runner reserves every possible transport attempt before gaxios dispatches. */
export class HttpLessonRenderer implements LessonRenderer {
  private readonly client = new Gaxios();
  constructor(
    private readonly url: string | undefined,
    private readonly secret: string | undefined,
  ) {}
  async readBuildId(): Promise<string> {
    if (!this.url || !this.secret) {
      throw new Error('Renderer is not configured.');
    }
    const result = await this.client.request<unknown>({
      url: `${this.url}/health`,
      headers: { authorization: `Bearer ${this.secret}` },
      timeout: 5000,
      retry: false,
      maxRedirects: 0,
      maxContentLength: 4096,
    });
    return LessonRendererHealthSchema.parse(result.data).buildId;
  }
  async render(
    request: LessonRenderRequest,
    timeoutMs: number,
    signal: AbortSignal,
    attempts: number,
  ): Promise<Uint8Array> {
    if (!this.url || !this.secret) {
      throw new Error('Renderer is not configured.');
    }
    const result = await this.client.request<unknown>({
      url: `${this.url}/render`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}` },
      data: request,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      timeout: timeoutMs,
      retry: true,
      retryConfig: {
        retry: attempts - 1,
        noResponseRetries: attempts - 1,
        httpMethodsToRetry: ['POST'],
        statusCodesToRetry: [
          [408, 408],
          [429, 429],
          [502, 504],
        ],
      },
      maxRedirects: 0,
      maxContentLength: Math.ceil((LessonLimits.VIDEO_BYTES * 4) / 3) + 1024,
    });
    return Buffer.from(LessonRenderReplySchema.parse(result.data).video, 'base64');
  }
}
