import type { Logger } from 'pino';

const ExchangeLimits = { DEPTH: 12, ITEMS: 16, TEXT_CHARS: 6000, NODES: 400 } as const;
const contentTraceLoggers = new WeakSet<Logger>();

/** Enable content traces only on the development worker logger. */
export function enableAgentExchangeLog(log: Logger): void {
  contentTraceLoggers.add(log);
}

type DebugValue = null | boolean | number | string | DebugValue[] | { [key: string]: DebugValue };

/** Development-only content traces. Screenshots, transport credentials and headers
 * are excluded before serialization; long histories are explicitly truncated. */
export function describeDebugExchange(value: unknown): DebugValue {
  let remainingNodes: number = ExchangeLimits.NODES;

  function visit(current: unknown, depth: number): DebugValue {
    remainingNodes -= 1;
    if (remainingNodes < 0 || depth > ExchangeLimits.DEPTH) {
      return '[truncated]';
    }
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current === 'boolean' || typeof current === 'number') {
      return current;
    }
    if (typeof current === 'string') {
      // Tool outputs and arguments often encode JSON inside a string.
      if (current.trimStart().startsWith('[') || current.trimStart().startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(current);
          return visit(parsed, depth + 1);
        } catch {
          // Non-JSON instructions remain readable text.
        }
      }
      const redacted = current
        .replace(/data:[^\s"']+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/\b(password|token|secret|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
      return redacted.length > ExchangeLimits.TEXT_CHARS
        ? redacted.slice(0, ExchangeLimits.TEXT_CHARS) + '[truncated]'
        : redacted;
    }
    if (Array.isArray(current)) {
      const items: unknown[] = current;
      return [
        ...items.slice(0, ExchangeLimits.ITEMS).map((item) => visit(item, depth + 1)),
        ...(items.length > ExchangeLimits.ITEMS ? ['[truncated items]'] : []),
      ];
    }
    if (current instanceof Error) {
      return visit(
        { name: current.name, message: current.message, cause: current.cause },
        depth + 1,
      );
    }
    if (typeof current === 'object') {
      const entries = Object.entries(current);
      if (
        entries.some(
          ([key, item]) => key === 'type' && typeof item === 'string' && /image|audio/.test(item),
        )
      ) {
        return '[media omitted]';
      }
      const result: { [key: string]: DebugValue } = {};
      for (const [key, item] of entries.slice(0, 40)) {
        const isPrivate =
          /token|secret|password|authorization|cookie|headers|api.?key|image|audio|base64|encrypted|session|endpoint|gateway.?url/i.test(
            key,
          );
        result[key] = isPrivate ? '[omitted]' : visit(item, depth + 1);
      }
      if (entries.length > 40) {
        result['truncatedFields'] = true;
      }
      return result;
    }
    return '[unsupported]';
  }

  return visit(value, 0);
}

interface AgentExchange {
  operation: string;
  input: unknown;
  output: unknown;
  error?: unknown;
  context?: Readonly<Record<string, unknown>>;
}

/** Production log levels never emit these content-bearing records. */
export function logAgentExchange(log: Logger, exchange: AgentExchange): void {
  if (!contentTraceLoggers.has(log) || !log.isLevelEnabled('debug')) {
    return;
  }
  log.debug(
    {
      ...exchange.context,
      operation: exchange.operation,
      input: describeDebugExchange(exchange.input),
      output: describeDebugExchange(exchange.output),
      error: describeDebugExchange(exchange.error),
    },
    'agent.debug.exchange',
  );
}
