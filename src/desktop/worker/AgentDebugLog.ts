import pino, { type Logger } from 'pino';

interface ModelRequestSummary {
  model: string | null;
  inputItems: number;
  textChars: number;
  imageParts: number;
  toolNames: string[];
}

interface ModelResponseSummary {
  outputTypes: string[];
  toolCalls: string[];
  inputTokens: number | null;
  outputTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/** Record only the shape of model traffic; text, images, and credentials stay out of logs. */
export function describeModelRequest(value: unknown): ModelRequestSummary {
  const request = isRecord(value) ? value : {};
  const input = request['input'];
  const inputItems: unknown[] = Array.isArray(input) ? input : [];
  const tools: unknown[] = Array.isArray(request['tools']) ? request['tools'] : [];
  let textChars = typeof input === 'string' ? input.length : 0;
  let imageParts = 0;

  for (const item of inputItems) {
    if (!isRecord(item)) {
      continue;
    }
    const content = item['content'];
    if (typeof content === 'string') {
      textChars += content.length;
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const parts: unknown[] = content;
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      if (part['type'] === 'input_image') {
        imageParts += 1;
      }
      if (typeof part['text'] === 'string') {
        textChars += part['text'].length;
      }
    }
  }

  return {
    model: readString(request['model']),
    inputItems: inputItems.length || (typeof input === 'string' ? 1 : 0),
    textChars,
    imageParts,
    toolNames: tools.flatMap((tool) => {
      if (!isRecord(tool)) {
        return [];
      }
      const name = readString(tool['name']);
      return name ? [name] : [];
    }),
  };
}

/** Report model output kinds and usage without persisting its answer or tool arguments. */
export function describeModelResponse(value: unknown): ModelResponseSummary {
  const response = isRecord(value) ? value : {};
  const output: unknown[] = Array.isArray(response['output']) ? response['output'] : [];
  const usage = isRecord(response['usage']) ? response['usage'] : {};

  return {
    outputTypes: output.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const type = readString(item['type']);
      return type ? [type] : [];
    }),
    toolCalls: output.flatMap((item) => {
      if (!isRecord(item) || item['type'] !== 'function_call') {
        return [];
      }
      const name = readString(item['name']);
      return name ? [name] : [];
    }),
    inputTokens: readNumber(usage['input_tokens']),
    outputTokens: readNumber(usage['output_tokens']),
  };
}

export function createAgentDebugLogger(debugEnabled: boolean): Logger {
  return pino({ name: 'tro-desktop-agent', level: debugEnabled ? 'debug' : 'silent' });
}

/** Observe the gateway exchange without logging HTTP headers, URLs, or bodies. */
export function createLoggedModelFetch(log: Logger): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const startedAt = performance.now();
    const requestBody = typeof init?.body === 'string' ? readJson(init.body) : null;
    log.debug(describeModelRequest(requestBody), 'openai.request');

    try {
      const response = await fetch(input, init);
      const contentType = response.headers.get('content-type') ?? '';
      let responseBody: unknown = null;
      if (contentType.includes('application/json')) {
        try {
          responseBody = readJson(await response.clone().text());
        } catch {
          /* Diagnostics must never turn a successful model response into a failure. */
        }
      }
      log.debug(
        {
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          ...describeModelResponse(responseBody),
        },
        'openai.response',
      );
      return response;
    } catch (error) {
      log.debug(
        {
          errorType: error instanceof Error ? error.name : typeof error,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'openai.failed',
      );
      throw error;
    }
  };
}
