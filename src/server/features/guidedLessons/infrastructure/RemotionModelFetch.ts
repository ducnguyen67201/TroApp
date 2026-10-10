import { Agent, fetch as fetchUndici } from 'undici';

export interface RemotionModelFetchOptions {
  dispatch?: typeof fetchUndici;
  createAgent?: (options: Agent.Options) => Agent;
}

/** Buffer the coding model's nonstreaming JSON response, then release its private connection pool.
 * A fresh matching Undici fetch/Agent pair prevents reuse across long render gaps and other providers.
 * Certificate verification remains enabled and the runtime chooses the address family.
 * Fresh connections on both IPv4 and IPv6 have failed with TLS bad-record-MAC alerts;
 * private pooling does not establish or resolve the remote or network cause of those failures.
 * This is a transport boundary, not a retry: each invocation dispatches at most once. */
export function createRemotionModelFetch(options: RemotionModelFetchOptions = {}): typeof fetch {
  const dispatch = options.dispatch ?? fetchUndici;
  const createAgent = options.createAgent ?? ((agentOptions) => new Agent(agentOptions));
  return async (input, init): Promise<Response> => {
    /* Standard Request construction validates URL, method, headers and body without copying SDK secrets to logs. */
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
    request.signal.throwIfAborted();
    const requestHeaders: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });
    const agent = createAgent({
      connections: 1,
      pipelining: 0,
      connect: { rejectUnauthorized: true },
    });
    let bodyRead = false;
    try {
      const response = await dispatch(request.url, {
        dispatcher: agent,
        method: request.method,
        headers: requestHeaders,
        ...(body === null ? {} : { body }),
        signal: request.signal,
        redirect: request.redirect,
      });
      const bytes = await response.arrayBuffer();
      bodyRead = true;
      const headers = new Headers();
      for (const [name, value] of response.headers) {
        headers.append(name, value);
      }
      const hasBody =
        request.method !== 'HEAD' &&
        response.status !== 204 &&
        response.status !== 205 &&
        response.status !== 304;
      return new Response(hasBody ? bytes : null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      await releaseOwnedAgent(agent, bodyRead);
    }
  };
}

async function releaseOwnedAgent(agent: Agent, bodyRead: boolean): Promise<void> {
  if (bodyRead) {
    try {
      await agent.close();
      return;
    } catch {
      /* Fall back to destruction; cleanup must not replace a received provider outcome. */
    }
  }
  try {
    await agent.destroy();
  } catch {
    /* Preserve the original dispatch outcome even if cleanup itself fails. */
  }
}
