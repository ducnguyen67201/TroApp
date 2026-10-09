import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  fetchModelResponse,
  type ModelAttemptDiagnostics,
} from '../src/server/auth/FetchModelResponse.js';
import { ModelTransportStage } from '#contracts/ModelTransportDiagnostics.js';
import {
  ModelConnectionUse,
  ModelFailureStage,
  ModelRequestTraceHeader,
  type ModelFailureEvidence,
} from '#contracts/ModelGatewayError.js';
import { describeModelFailureEvidence } from '../src/server/auth/ModelFailureEvidence.js';
import {
  createModelGatewayFixture,
  ModelGatewayFixtureMode,
  type ModelGatewayFixture,
  type ModelGatewayFixtureLog,
  type ModelGatewayProviderEvidence,
} from '../test/server/auth/flow/ModelGatewayFixture.js';

interface DiagnosticCaseResult {
  name: string;
  passed: boolean;
  durationMs: number;
  gatewayStatuses: number[];
  observedCause: string;
  failureStage: ModelFailureEvidence['failureStage'] | null;
  expectedFailureStage: ModelFailureEvidence['failureStage'] | null;
  logs: (ModelGatewayFixtureLog | ModelGatewayProviderEvidence)[];
}

interface MeasuredDiagnosticResult {
  observedCause: string;
  failureStage: ModelFailureEvidence['failureStage'];
}

const artifactDirectory = resolve('.tro-development/model-gateway-diagnostics');
const results: DiagnosticCaseResult[] = [];
const recordedEvents: string[] = [];

function findFailedAttempt(fixture: ModelGatewayFixture): ModelGatewayFixtureLog {
  const attempt = fixture.logs.find(
    (entry) => entry.event === 'model.gateway.attempt' && entry.phase === 'failed',
  );
  assert.ok(attempt, 'A failed request must retain its attempt evidence.');
  assert.ok(attempt.transport, 'A real request must retain its transport snapshot.');
  assert.equal(attempt.transport.transportObserved, true);
  assert.equal(attempt.transport.providerHeadersReceived, false);
  return attempt;
}

async function waitForFailure(fixture: ModelGatewayFixture): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!fixture.logs.some((entry) => entry.event === 'model.gateway.failed')) {
    assert.ok(performance.now() < deadline, 'Expected a bounded gateway failure event.');
    await delay(10);
  }
}

async function runCase(
  name: string,
  mode: ModelGatewayFixtureMode,
  expectedFailureStage: ModelFailureEvidence['failureStage'] | null,
  check: (
    fixture: ModelGatewayFixture,
    statuses: number[],
  ) => Promise<string | MeasuredDiagnosticResult>,
): Promise<void> {
  const startedAt = performance.now();
  const logs: (ModelGatewayFixtureLog | ModelGatewayProviderEvidence)[] = [];
  const fixture = await createModelGatewayFixture(mode, (event) => {
    logs.push(event);
    recordedEvents.push(JSON.stringify({ case: name, ...event }));
  });
  const statuses: number[] = [];
  let passed = false;
  let observedCause = 'check_failed';
  let measuredFailureStage: ModelFailureEvidence['failureStage'] | null = null;
  try {
    const measurement = await check(fixture, statuses);
    if (typeof measurement === 'string') {
      observedCause = measurement;
    } else {
      observedCause = measurement.observedCause;
      measuredFailureStage = measurement.failureStage;
    }
    const failure = fixture.logs.find((entry) => entry.event === 'model.gateway.failed');
    if (expectedFailureStage !== null) {
      const actualFailureStage = failure?.failureStage ?? measuredFailureStage;
      assert.ok(actualFailureStage, 'A failure must retain its measured evidence classification.');
      assert.equal(actualFailureStage, expectedFailureStage);
    }
    const correlated = fixture.logs.filter((entry) => entry.gatewayRequestId);
    if (name !== 'local deadline expired') {
      assert.ok(correlated.length > 0);
      assert.ok(
        correlated.every(
          (entry) => entry.modelRequestId !== null && entry.modelRequestId !== undefined,
        ),
      );
      const startedAttempts = fixture.logs.filter(
        (entry) => entry.event === 'model.gateway.attempt' && entry.phase === 'started',
      );
      assert.ok(startedAttempts.length > 0);
      assert.ok(startedAttempts.every((entry) => entry.providerClientRequestId));
      assert.equal(
        new Set(startedAttempts.map((entry) => entry.providerClientRequestId)).size,
        startedAttempts.length,
        'Each provider attempt needs its own receipt lookup ID.',
      );
      for (const started of startedAttempts) {
        const settled = fixture.logs.find(
          (entry) =>
            entry.event === 'model.gateway.attempt' &&
            entry.phase !== 'started' &&
            entry.providerClientRequestId === started.providerClientRequestId,
        );
        assert.ok(
          settled,
          'Every dispatched provider attempt must retain its ID after success or failure.',
        );
        assert.equal(settled.gatewayRequestId, started.gatewayRequestId);
        assert.equal(settled.attemptNumber, started.attemptNumber);
      }
      assert.ok(
        fixture.providerEvidence.every(
          (entry) =>
            entry.providerClientRequestId !== null &&
            startedAttempts.some(
              (attempt) => attempt.providerClientRequestId === entry.providerClientRequestId,
            ),
        ),
        'The controlled peer must receive the provider attempt lookup ID.',
      );
    }
    assert.ok(!JSON.stringify(logs).includes(fixture.token), 'Credential leaked into logs.');
    assert.ok(
      !JSON.stringify(logs).includes('synthetic fixture content'),
      'Input leaked into logs.',
    );
    assert.ok(!JSON.stringify(logs).includes(fixture.providerUrl), 'Address leaked into logs.');
    assert.ok(
      fixture.hasSafeLogs(),
      'Raw gateway log output leaked fixture content or exceeded the diagnostic limit.',
    );
    passed = true;
  } finally {
    await fixture.close();
    const result: DiagnosticCaseResult = {
      name,
      passed,
      durationMs: Math.round(performance.now() - startedAt),
      gatewayStatuses: statuses,
      observedCause,
      failureStage:
        fixture.logs.find((entry) => entry.event === 'model.gateway.failed')?.failureStage ??
        measuredFailureStage,
      expectedFailureStage,
      logs,
    };
    results.push(result);
    console.info(JSON.stringify({ event: 'fixture.case.completed', ...result, logs: undefined }));
  }
}

async function checkGatewayFailures(): Promise<void> {
  await runCase(
    'TLS handshake rejected',
    ModelGatewayFixtureMode.INVALID_TLS_PEER,
    ModelFailureStage.BEFORE_CONNECTION,
    async (fixture, statuses) => {
      const response = await fixture.sendRequest();
      statuses.push(response.status);
      await response.text();
      assert.equal(response.status, 502);
      const attempt = findFailedAttempt(fixture);
      assert.equal(attempt.transport?.socketAssigned, false);
      assert.equal(attempt.transport.requestBodySent, false);
      assert.equal(attempt.retryEligible, false);
      assert.equal(fixture.providerEvidence.length, 0);
      const failure = fixture.logs.find((entry) => entry.event === 'model.gateway.failed');
      assert.ok(
        failure?.socketErrorCode,
        'Preserve the safe TLS cause rather than a generic fetch error.',
      );
      return 'TLS setup failed against an intentionally invalid local peer; the model body was never uploaded.';
    },
  );

  await runCase(
    'upload interrupted',
    ModelGatewayFixtureMode.CLOSE_DURING_UPLOAD,
    ModelFailureStage.UPLOAD,
    async (fixture, statuses) => {
      const response = await fixture.sendRequest(6 * 1024 * 1024);
      statuses.push(response.status);
      await response.text();
      assert.equal(response.status, 502);
      const attempt = findFailedAttempt(fixture);
      assert.equal(attempt.transport?.socketAssigned, true);
      assert.ok(fixture.providerEvidence.length > 0);
      assert.ok(fixture.providerEvidence.every((entry) => !entry.requestBodyComplete));
      assert.ok(
        fixture.providerEvidence.every(
          (entry) =>
            entry.expectedRequestBytes !== null &&
            entry.requestBytesReceived < entry.expectedRequestBytes,
        ),
      );
      const failures = fixture.logs.filter(
        (entry) => entry.event === 'model.gateway.attempt' && entry.phase === 'failed',
      );
      assert.equal(failures.length, 2);
      for (const failure of failures) {
        assert.ok(failure.transport);
        assert.equal(failure.transport.requestBodySent, true);
        assert.equal(failure.transport.requestBodySentAfterSocketClosed, true);
        const events = failure.transport.events ?? [];
        const closedAt = events.findIndex(
          (event) => event.stage === ModelTransportStage.SOCKET_CLOSED,
        );
        const sentAt = events.findIndex((event) => event.stage === ModelTransportStage.BODY_SENT);
        assert.ok(
          closedAt >= 0 && sentAt > closedAt,
          'Retain the observed socket-close before body-sent ordering.',
        );
      }
      return 'The peer received only part of the upload and closed the socket; the local body-sent event arrived after closure, so it cannot prove a completed upload. No HTTP headers arrived.';
    },
  );

  await runCase(
    'peer closed after upload',
    ModelGatewayFixtureMode.CLOSE_BEFORE_HEADERS,
    ModelFailureStage.WAITING_FOR_HEADERS,
    async (fixture, statuses) => {
      const response = await fixture.sendRequest();
      statuses.push(response.status);
      await response.text();
      assert.equal(response.status, 502);
      const attempt = findFailedAttempt(fixture);
      assert.equal(attempt.transport?.requestBodySent, true);
      assert.ok(fixture.providerEvidence.every((entry) => entry.requestBodyComplete));
      const failures = fixture.logs.filter(
        (entry) => entry.event === 'model.gateway.attempt' && entry.phase === 'failed',
      );
      assert.equal(failures.length, 2);
      assert.notEqual(failures[0]?.transport?.connectionId, failures[1]?.transport?.connectionId);
      assert.equal(failures[0]?.transport?.socketHadPriorTraffic, false);
      assert.equal(failures[1]?.transport?.socketHadPriorTraffic, false);
      assert.ok(failures.every((failure) => failure.connectionUse === ModelConnectionUse.NEW));
      return 'Two fresh peers received the full body, then closed before returning HTTP headers.';
    },
  );

  await runCase(
    'malformed HTTP response',
    ModelGatewayFixtureMode.MALFORMED_HEADERS,
    ModelFailureStage.WAITING_FOR_HEADERS,
    async (fixture, statuses) => {
      const response = await fixture.sendRequest();
      statuses.push(response.status);
      await response.text();
      assert.equal(response.status, 502);
      const attempt = findFailedAttempt(fixture);
      assert.equal(attempt.transport?.requestBodySent, true);
      assert.equal(fixture.providerEvidence.length, 1);
      return 'The peer supplied invalid HTTP headers; the parser rejected them without a retry.';
    },
  );

  await runCase(
    'provider HTTP rejection',
    ModelGatewayFixtureMode.PROVIDER_REJECTION,
    ModelFailureStage.PROVIDER_RESPONSE,
    async (fixture, statuses) => {
      const response = await fixture.sendRequest();
      statuses.push(response.status);
      await response.text();
      assert.equal(response.status, 502);
      const failure = fixture.logs.find((entry) => entry.event === 'model.gateway.failed');
      assert.ok(failure);
      assert.equal(failure.reason, 'provider_rejected');
      assert.equal(failure.providerStatus, 400);
      assert.equal(failure.providerErrorCode, 'invalid_value');
      assert.equal(fixture.providerEvidence.length, 1);
      assert.ok(!fixture.logs.some((entry) => entry.event === 'model.gateway.retry'));
      return 'The provider returned HTTP 400; Tro translated that rejection into HTTP 502.';
    },
  );

  await runCase(
    'response stream truncated',
    ModelGatewayFixtureMode.TRUNCATE_RESPONSE,
    ModelFailureStage.RESPONSE_STREAM,
    async (fixture, statuses) => {
      const response = await fixture.sendRequest();
      statuses.push(response.status);
      await response.text();
      await waitForFailure(fixture);
      assert.equal(response.status, 200);
      const failure = fixture.logs.find((entry) => entry.event === 'model.gateway.failed');
      assert.ok(failure);
      assert.equal(failure.reason, 'provider_stream_failed');
      assert.ok((failure.responseBytes ?? 0) > 0);
      assert.equal(fixture.providerEvidence.length, 1);
      assert.ok(!fixture.logs.some((entry) => entry.event === 'model.gateway.retry'));
      assert.ok(!fixture.logs.some((entry) => entry.event === 'model.gateway.completed'));
      return 'Response headers and some bytes arrived, then the peer truncated its promised body; no stream replay occurred.';
    },
  );

  await runCase(
    'desktop disconnected',
    ModelGatewayFixtureMode.HOLD_HEADERS,
    ModelFailureStage.CLIENT_DISCONNECTED,
    async (fixture) => {
      const cancellation = new AbortController();
      const pending = fixture.sendRequest(1024, cancellation.signal);
      const rejection = assert.rejects(pending);
      await fixture.waitForProviderRequest();
      cancellation.abort();
      await rejection;
      await waitForFailure(fixture);
      const failure = fixture.logs.find((entry) => entry.event === 'model.gateway.failed');
      assert.equal(failure?.reason, 'client_disconnected');
      const attempt = findFailedAttempt(fixture);
      assert.equal(attempt.aborted, true);
      assert.equal(attempt.retryEligible, false);
      assert.ok(!fixture.logs.some((entry) => entry.event === 'model.gateway.retry'));
      return 'The desktop closed its request first; the gateway canceled its provider request.';
    },
  );

  await runCase(
    'local deadline expired',
    ModelGatewayFixtureMode.HOLD_HEADERS,
    ModelFailureStage.DEADLINE,
    async (fixture) => {
      const attempts: ModelAttemptDiagnostics[] = [];
      await assert.rejects(
        fetchModelResponse(
          'synthetic-local-provider-key-0000',
          '{}',
          AbortSignal.timeout(100),
          () => assert.fail('A canceled request must not be retried.'),
          (attempt) => {
            attempts.push(attempt);
            recordedEvents.push(
              JSON.stringify({
                case: 'local deadline expired',
                event: 'fixture.transport.attempt',
                ...attempt,
              }),
            );
          },
        ),
      );
      const failure = attempts.find((attempt) => attempt.phase === 'failed');
      assert.ok(failure);
      assert.equal(failure.aborted, true);
      assert.equal(failure.retryEligible, false);
      assert.ok(failure.providerClientRequestId);
      assert.equal(attempts[0]?.providerClientRequestId, failure.providerClientRequestId);
      assert.equal(
        fixture.providerEvidence[0]?.providerClientRequestId,
        failure.providerClientRequestId,
      );
      assert.equal(failure.transport?.providerHeadersReceived, false);
      const evidence = describeModelFailureEvidence({
        timedOut: true,
        transport: failure.transport,
      });
      assert.equal(evidence.failureStage, ModelFailureStage.DEADLINE);
      assert.equal(fixture.providerEvidence.length, 1);
      return {
        observedCause:
          'The local 100 ms deadline expired while waiting for headers; cancellation stopped retry.',
        failureStage: evidence.failureStage,
      };
    },
  );

  await runCase(
    'fresh and reused success',
    ModelGatewayFixtureMode.SUCCESS,
    null,
    async (fixture, statuses) => {
      for (let index = 0; index < 3; index += 1) {
        const response = await fixture.sendRequest();
        statuses.push(response.status);
        await response.text();
        assert.equal(response.status, 200);
        const trace = response.headers.get(ModelRequestTraceHeader);
        const gatewayRequestId = response.headers.get('x-tro-request-id');
        assert.ok(trace, 'Successful streaming must reflect the model request trace.');
        assert.ok(
          fixture.logs.some(
            (entry) =>
              entry.event === 'model.gateway.request' &&
              entry.modelRequestId === trace &&
              entry.gatewayRequestId === gatewayRequestId,
          ),
        );
        await delay(20);
      }
      const attempts = fixture.logs.filter(
        (entry) => entry.event === 'model.gateway.attempt' && entry.phase === 'headers_received',
      );
      assert.equal(attempts.length, 3);
      assert.equal(attempts[0]?.transport?.socketHadPriorTraffic, false);
      const reused = attempts.find((entry) => entry.transport?.socketHadPriorTraffic);
      assert.ok(reused, 'At least one request must reuse a locally observed connection.');
      assert.equal(reused.transport?.connectionId, attempts[0].transport.connectionId);
      assert.equal(
        fixture.logs.filter((entry) => entry.event === 'model.gateway.completed').length,
        3,
      );
      const deliveries = fixture.logs.filter((entry) => entry.event === 'model.gateway.delivered');
      assert.equal(deliveries.length, 3);
      assert.ok(
        deliveries.every((entry) => entry.status === 200 && entry.responseFinished === true),
      );
      assert.ok(!fixture.logs.some((entry) => entry.event === 'model.gateway.failed'));
      assert.ok(
        attempts.every(
          (entry) =>
            entry.transport?.lastTransportStage === ModelTransportStage.RESPONSE_HEADERS ||
            entry.transport?.providerHeadersReceived,
        ),
      );
      return 'Fresh and pooled connections both completed; connection identity and prior traffic distinguish reuse.';
    },
  );
}

try {
  await checkGatewayFailures();
} finally {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    resolve(artifactDirectory, 'GatewayEvents.jsonl'),
    recordedEvents.join('\n') + '\n',
  );
  await writeFile(
    resolve(artifactDirectory, 'GatewayReport.json'),
    JSON.stringify({ cases: results }, null, 2) + '\n',
  );
  console.info(
    JSON.stringify({
      event: 'fixture.report.saved',
      directory: artifactDirectory,
      passedCases: results.filter((entry) => entry.passed).length,
      totalCases: results.length,
    }),
  );
}
