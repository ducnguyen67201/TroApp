import { MCPServerStdio, type CallToolResult, type MCPCallToolOptions } from '@openai/agents';
import type { Logger } from 'pino';

function describeArgumentValue(value: unknown): { type: string; length?: number } {
  if (typeof value === 'string') {
    return { type: 'string', length: value.length };
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  return { type: value === null ? 'null' : typeof value };
}

/** Preserve argument names and types while excluding values such as typed passwords. */
export function describeCuaArguments(
  args: Record<string, unknown> | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (args === null) {
    return fields;
  }
  for (const [name, value] of Object.entries(args)) {
    fields[name] = describeArgumentValue(value);
  }
  return fields;
}

/** MCP results can contain screen images and page text, so report content kinds only. */
export function describeCuaResult(value: unknown): {
  isError: boolean;
  contentTypes: string[];
  textChars: number;
  hasStructuredContent: boolean;
} {
  const result = typeof value === 'object' && value !== null ? value : {};
  const content: unknown = 'content' in result ? result.content : null;
  const items: unknown[] = Array.isArray(content) ? content : [];
  const contentTypes: string[] = [];
  let textChars = 0;

  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('type' in item)) {
      continue;
    }
    if (typeof item.type === 'string') {
      contentTypes.push(item.type);
    }
    if ('text' in item && typeof item.text === 'string') {
      textChars += item.text.length;
    }
  }

  return {
    isError: 'isError' in result && result.isError === true,
    contentTypes,
    textChars,
    hasStructuredContent: 'structuredContent' in result && result.structuredContent !== undefined,
  };
}

/** Trace the real SDK-to-Cua MCP boundary; the SDK calls this method for each tool. */
export class LoggedCuaServer extends MCPServerStdio {
  constructor(
    options: ConstructorParameters<typeof MCPServerStdio>[0],
    private readonly log: Logger,
  ) {
    super(options);
  }

  override async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    if (!this.log.isLevelEnabled('debug')) {
      return super.callToolResult(toolName, args, meta, options);
    }

    const startedAt = performance.now();
    this.log.debug({ toolName, arguments: describeCuaArguments(args) }, 'cua.request');
    try {
      const result = await super.callToolResult(toolName, args, meta, options);
      this.log.debug(
        {
          toolName,
          durationMs: Math.round(performance.now() - startedAt),
          ...describeCuaResult(result),
        },
        'cua.response',
      );
      return result;
    } catch (error) {
      this.log.debug(
        {
          toolName,
          errorType: error instanceof Error ? error.name : typeof error,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'cua.failed',
      );
      throw error;
    }
  }
}
