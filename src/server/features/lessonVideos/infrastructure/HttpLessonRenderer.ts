import { Gaxios, GaxiosError } from 'gaxios';
import {
  LessonRendererHealthSchema,
  LessonRenderReplySchema,
  LessonRenderFailureSchema,
  type LessonRenderRequest,
} from '#contracts/LessonRenderProtocol.js';
import { LessonLimits } from '#contracts/LessonVideos.js';
import { LessonRenderCodeError, type LessonRenderer } from '../application/LessonVideoPorts.js';

/** The runner reserves every possible transport attempt before gaxios dispatches. */
export class HttpLessonRenderer implements LessonRenderer {
  private readonly client = new Gaxios();
  constructor(
    private readonly url: string | undefined,
    private readonly secret: string | undefined,
  ) {}

  async readBuildId(): Promise<string> {
    return (await this.fetchHealth()).buildId;
  }

  async readVisualRuntime(): Promise<string | null> {
    return (await this.fetchHealth()).visualRuntimeVersion ?? null;
  }

  private async fetchHealth() {
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
    return LessonRendererHealthSchema.parse(result.data);
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
    try {
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
    } catch (error) {
      if (error instanceof GaxiosError && error.response?.status === 422) {
        const failure = LessonRenderFailureSchema.safeParse(error.response.data);
        if (failure.success && failure.data.kind === 'code-error') {
          throw new LessonRenderCodeError(failure.data.diagnostic);
        }
      }
      throw error;
    }
  }
}
