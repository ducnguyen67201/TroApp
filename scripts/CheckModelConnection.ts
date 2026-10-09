import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { TLSSocket } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ProviderClientRequestHeader } from '#contracts/ModelGatewayError.js';
import { ModelTlsDetailsSchema } from '#contracts/ModelTransportDiagnostics.js';
import {
  describeNetworkFailure,
  readProviderRequestId,
} from '../src/server/auth/ModelGatewayDiagnostics.js';
import { describeModelFailureEvidence } from '../src/server/auth/ModelFailureEvidence.js';
import { ModelTransportObserver } from '../src/server/auth/ModelTransportObserver.js';
import { describeSocketClose } from '../src/server/auth/SocketCloseDiagnostics.js';
import { readModelConnectionEnv } from './Env.js';

const executeFile = promisify(execFile);
const ProbeLimits = { TIMEOUT_MS: 5000, MAX_RESPONSE_BYTES: 16 * 1024, FETCH_REQUESTS: 3 } as const;
const providerHost = 'api.openai.com';
const probeUrl = 'https://' + providerHost + '/v1/models';
const directory = resolve('.tro-development/model-connection');

/** Count DNS families without persisting IP addresses or host configuration. */
async function readDnsEvidence() {
  const startedAt = performance.now();
  try {
    const records = await Promise.race([
      lookup(providerHost, { all: true }),
      delay(ProbeLimits.TIMEOUT_MS, undefined, { ref: false }).then(() => {
        throw new DOMException('DNS probe deadline.', 'TimeoutError');
      }),
    ]);
    return {
      succeeded: true,
      durationMs: Math.round(performance.now() - startedAt),
      ipv4Addresses: records.filter((record) => record.family === 4).length,
      ipv6Addresses: records.filter((record) => record.family === 6).length,
    };
  } catch (error) {
    return {
      succeeded: false,
      durationMs: Math.round(performance.now() - startedAt),
      ...describeNetworkFailure(error),
      ...describeSocketClose(error),
    };
  }
}

/** macOS proxy flags only. The command's addresses, PAC URLs and values are discarded. */
async function readSystemProxyEvidence() {
  if (process.platform !== 'darwin') {
    return { available: false };
  }
  try {
    const output = await executeFile('/usr/sbin/scutil', ['--proxy'], {
      timeout: ProbeLimits.TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    return {
      available: true,
      httpProxyEnabled: /HTTPEnable\s*:\s*1\b/.test(output.stdout),
      httpsProxyEnabled: /HTTPSEnable\s*:\s*1\b/.test(output.stdout),
      socksProxyEnabled: /SOCKSEnable\s*:\s*1\b/.test(output.stdout),
      automaticProxyEnabled: /ProxyAutoConfigEnable\s*:\s*1\b/.test(output.stdout),
      automaticDiscoveryEnabled: /ProxyAutoDiscoveryEnable\s*:\s*1\b/.test(output.stdout),
    };
  } catch {
    return { available: false };
  }
}

async function discardResponseBody(response: Response): Promise<number> {
  if (!response.body) {
    return 0;
  }
  const reader = response.body.getReader();
  let responseBytes = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      responseBytes += chunk.value.byteLength;
      if (responseBytes > ProbeLimits.MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Probe response exceeded the byte limit.');
      }
      chunk = await reader.read();
    }
    return responseBytes;
  } finally {
    reader.releaseLock();
  }
}

/** Same native fetch as the gateway; no authentication, model input or inference. */
async function probeNativeFetch(attemptNumber: number) {
  const providerClientRequestId = randomUUID();
  const observer = new ModelTransportObserver();
  const startedAt = performance.now();
  let providerStatus: number | undefined;
  const timeout = AbortSignal.timeout(ProbeLimits.TIMEOUT_MS);
  try {
    const response = await observer.observe(() =>
      fetch(probeUrl, {
        method: 'GET',
        redirect: 'error',
        headers: { [ProviderClientRequestHeader]: providerClientRequestId },
        signal: timeout,
      }),
    );
    providerStatus = response.status;
    const responseBytes = await discardResponseBody(response);
    return {
      mode: 'native_fetch',
      attemptNumber,
      providerClientRequestId,
      reachedHttpService: true,
      expectedUnauthorizedResponse: response.status === 401,
      providerStatus,
      providerRequestId: readProviderRequestId(response.headers),
      responseBytes,
      durationMs: Math.round(performance.now() - startedAt),
      transport: observer.readSnapshot(),
    };
  } catch (error) {
    const transport = observer.readSnapshot();
    return {
      mode: 'native_fetch',
      attemptNumber,
      providerClientRequestId,
      reachedHttpService: providerStatus !== undefined,
      providerStatus: providerStatus ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      ...describeNetworkFailure(error),
      ...describeSocketClose(error),
      ...describeModelFailureEvidence({
        transport,
        timedOut: timeout.aborted,
        streamFailed: providerStatus !== undefined,
      }),
      transport,
    };
  }
}

interface HttpsProbeResult {
  mode: 'fresh_https_ipv4' | 'fresh_https_ipv6';
  providerClientRequestId: string;
  reachedHttpService: boolean;
  durationMs: number;
  providerStatus?: number;
  providerRequestId?: string | null;
  expectedUnauthorizedResponse?: boolean;
  tlsAuthorized?: boolean;
  tlsProtocol?: 'TLSv1.2' | 'TLSv1.3' | null;
  socketAddressFamily?: 'IPv4' | 'IPv6' | null;
  tlsCipher?: z.infer<typeof ModelTlsDetailsSchema>['tlsCipher'];
  failure?: ReturnType<typeof describeNetworkFailure> & ReturnType<typeof describeSocketClose>;
}

/** Fresh Node HTTPS sockets compare address families. Never change the gateway's dispatcher. */
function probeFreshHttps(family: 4 | 6): Promise<HttpsProbeResult> {
  const startedAt = performance.now();
  const providerClientRequestId = randomUUID();
  const mode = family === 4 ? 'fresh_https_ipv4' : 'fresh_https_ipv6';
  return new Promise((resolveResult) => {
    const outgoing = request(probeUrl, {
      method: 'GET',
      agent: false,
      family,
      signal: AbortSignal.timeout(ProbeLimits.TIMEOUT_MS),
      headers: { [ProviderClientRequestHeader]: providerClientRequestId },
    });
    let settled = false;

    function settle(result: HttpsProbeResult): void {
      if (!settled) {
        settled = true;
        resolveResult(result);
      }
    }

    outgoing.once('response', (response) => {
      const socket = response.socket;
      const protocol = socket instanceof TLSSocket ? socket.getProtocol() : null;
      const cipher = ModelTlsDetailsSchema.shape.tlsCipher.safeParse(
        socket instanceof TLSSocket ? socket.getCipher().name : null,
      );
      const requestId = response.headers['x-request-id'];
      settle({
        mode,
        providerClientRequestId,
        reachedHttpService: true,
        durationMs: Math.round(performance.now() - startedAt),
        providerStatus: response.statusCode ?? 0,
        expectedUnauthorizedResponse: response.statusCode === 401,
        providerRequestId:
          typeof requestId === 'string' && /^req_[A-Za-z0-9_-]{1,128}$/.test(requestId)
            ? requestId
            : null,
        tlsAuthorized: socket instanceof TLSSocket && socket.authorized,
        tlsProtocol: protocol === 'TLSv1.2' || protocol === 'TLSv1.3' ? protocol : null,
        tlsCipher: cipher.success ? cipher.data : null,
        socketAddressFamily:
          socket.remoteFamily === 'IPv4' || socket.remoteFamily === 'IPv6'
            ? socket.remoteFamily
            : null,
      });
      response.destroy();
    });
    outgoing.once('error', (error) => {
      settle({
        mode,
        providerClientRequestId,
        reachedHttpService: false,
        durationMs: Math.round(performance.now() - startedAt),
        failure: { ...describeNetworkFailure(error), ...describeSocketClose(error) },
      });
    });
    outgoing.end();
  });
}

try {
  const environment = readModelConnectionEnv(process.env, process.execArgv);
  const systemProxy = await readSystemProxyEvidence();
  const dns = await readDnsEvidence();
  const nativeProbes: Awaited<ReturnType<typeof probeNativeFetch>>[] = [];
  for (let attemptNumber = 1; attemptNumber <= ProbeLimits.FETCH_REQUESTS; attemptNumber += 1) {
    nativeProbes.push(await probeNativeFetch(attemptNumber));
    if (attemptNumber < ProbeLimits.FETCH_REQUESTS) {
      await delay(attemptNumber === 1 ? 50 : 1000);
    }
  }
  const freshProbes = await Promise.all([probeFreshHttps(4), probeFreshHttps(6)]);
  const report = {
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.versions.node,
      undici: process.versions['undici'] ?? null,
      openssl: process.versions.openssl,
    },
    environment,
    systemProxy,
    dns,
    nativeProbes,
    freshProbes,
    limitation:
      'Credentialless GET probes test current DNS/TLS/HTTP reachability. They do not reproduce authenticated screenshot uploads, provider inference or the earlier disconnect. Fresh HTTPS and fetch may use different proxy routes; configuration presence does not prove routing.',
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'ConnectionReport.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.info(JSON.stringify({ event: 'model.connection.probe.completed', ...report, directory }));
} catch (error) {
  console.error(
    JSON.stringify({ event: 'model.connection.probe.failed', ...describeNetworkFailure(error) }),
  );
  process.exitCode = 1;
}
