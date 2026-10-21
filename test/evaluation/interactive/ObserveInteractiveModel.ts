import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelRequestTraceHeader } from '../../../src/contracts/ModelGatewayError.js';
import type { InteractiveModelRequest } from './InteractiveAgentProtocol.js';

export const InteractiveModelObservationLimits = {
  MAXIMUM_BUFFER_BYTES: 256 * 1024,
  MAXIMUM_REQUESTS: 1000,
} as const;

const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UsageSchema = z.object({
  input_tokens: TokenCountSchema,
  output_tokens: TokenCountSchema,
  input_tokens_details: z
    .object({
      cached_tokens: TokenCountSchema.default(0),
      cache_write_tokens: TokenCountSchema.optional(),
    })
    .optional(),
});

export interface InteractiveUsageCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Observes only terminal provider usage. Retained JSON/line buffers are bounded;
 * body bytes are never logged or persisted. This reads one gateway response, not
 * every upstream attempt that the gateway may have made before returning it. */
export class InteractiveModelUsageReader {
  private readonly decoder = new TextDecoder();
  private readonly streaming: boolean;
  private buffer = '';
  private skippingLine = false;
  private oversizedJson = false;
  private usage: InteractiveUsageCounts | null = null;

  constructor(contentType: string) {
    this.streaming = contentType.toLowerCase().includes('text/event-stream');
  }

  accept(bytes: Uint8Array): void {
    this.acceptText(this.decoder.decode(bytes, { stream: true }));
  }

  finish(): InteractiveUsageCounts | null {
    this.acceptText(this.decoder.decode());
    if (!this.streaming && !this.oversizedJson) {
      this.readJson(this.buffer);
    } else if (this.streaming && !this.skippingLine && this.buffer) {
      this.readStreamLine(this.buffer);
    }
    this.buffer = '';
    return this.readUsage();
  }

  readUsage(): InteractiveUsageCounts | null {
    return this.usage ? { ...this.usage } : null;
  }

  private acceptText(text: string): void {
    if (!this.streaming) {
      if (!this.oversizedJson) {
        this.buffer += text;
        if (
          Buffer.byteLength(this.buffer) > InteractiveModelObservationLimits.MAXIMUM_BUFFER_BYTES
        ) {
          this.buffer = '';
          this.oversizedJson = true;
        }
      }
      return;
    }
    let offset = 0;
    let end = text.indexOf('\n');
    while (end >= 0) {
      const fragment = text.slice(offset, end);
      if (!this.skippingLine) {
        if (this.appendFragment(fragment)) {
          this.readStreamLine(this.buffer);
        }
      }
      this.buffer = '';
      this.skippingLine = false;
      offset = end + 1;
      end = text.indexOf('\n', offset);
    }
    if (!this.skippingLine) {
      this.appendFragment(text.slice(offset));
    }
  }

  private appendFragment(fragment: string): boolean {
    if (
      Buffer.byteLength(this.buffer) + Buffer.byteLength(fragment) >
      InteractiveModelObservationLimits.MAXIMUM_BUFFER_BYTES
    ) {
      this.buffer = '';
      this.skippingLine = true;
      return false;
    }
    this.buffer += fragment;
    return true;
  }

  private readStreamLine(line: string): void {
    const value = line.trim();
    if (value.startsWith('data:')) {
      this.readJson(value.slice(5).trim());
    }
  }

  private readJson(text: string): void {
    try {
      const raw: unknown = JSON.parse(text);
      const envelope = z
        .object({
          type: z.string().optional(),
          usage: z.unknown().optional(),
          response: z.object({ usage: z.unknown().optional() }).optional(),
        })
        .safeParse(raw);
      if (!envelope.success) {
        return;
      }
      if (
        this.streaming &&
        !['response.completed', 'response.incomplete', 'response.failed'].includes(
          envelope.data.type ?? '',
        )
      ) {
        return;
      }
      const parsed = UsageSchema.safeParse(envelope.data.response?.usage ?? envelope.data.usage);
      if (!parsed.success) {
        return;
      }
      const cached = parsed.data.input_tokens_details?.cached_tokens ?? 0;
      const written = parsed.data.input_tokens_details?.cache_write_tokens ?? 0;
      if (cached + written > parsed.data.input_tokens) {
        return;
      }
      this.usage = {
        inputTokens: parsed.data.input_tokens,
        cachedInputTokens: cached,
        outputTokens: parsed.data.output_tokens,
      };
    } catch {
      // Missing or malformed terminal usage remains unknown, never a free request.
    }
  }
}

interface PendingModelRequest {
  id: string;
  status: number | null;
  startedAt: number;
  finishedAt: number | null;
  reader: InteractiveModelUsageReader | null;
}

export interface InteractiveModelObserver {
  fetch: typeof fetch;
  readRequests(): InteractiveModelRequest[];
}

/** Tee-free response observation preserves backpressure and forwards the exact bytes.
 * Only request IDs, HTTP status, elapsed time and terminal token counts escape. */
export function observeInteractiveModelFetch(
  fetchModel: typeof fetch = fetch,
): InteractiveModelObserver {
  const requests: PendingModelRequest[] = [];
  const observedFetch: typeof fetch = async (input, init) => {
    if (requests.length >= InteractiveModelObservationLimits.MAXIMUM_REQUESTS) {
      throw new Error('The evaluation request count limit was reached.');
    }
    const observed: PendingModelRequest = {
      id: randomUUID(),
      status: null,
      startedAt: performance.now(),
      finishedAt: null,
      reader: null,
    };
    requests.push(observed);
    const headers = new Headers(init?.headers);
    headers.set(ModelRequestTraceHeader, observed.id);
    try {
      const response = await fetchModel(input, { ...init, headers, redirect: 'error' });
      observed.status = response.status;
      const reader = new InteractiveModelUsageReader(response.headers.get('content-type') ?? '');
      observed.reader = reader;
      if (!response.body) {
        reader.finish();
        observed.finishedAt = performance.now();
        return response;
      }
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            reader.accept(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            reader.finish();
            observed.finishedAt = performance.now();
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      observed.finishedAt = performance.now();
      throw error;
    }
  };
  return {
    fetch: observedFetch,
    readRequests: () =>
      requests.map((request) => {
        const usage = request.reader?.readUsage();
        return {
          id: request.id,
          status: request.status,
          durationMs: Math.max(0, (request.finishedAt ?? performance.now()) - request.startedAt),
          inputTokens: usage?.inputTokens ?? null,
          cachedInputTokens: usage?.cachedInputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
        };
      }),
  };
}
