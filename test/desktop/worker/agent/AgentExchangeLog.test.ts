import { PassThrough } from 'node:stream';
import pino from 'pino';
import { expect, it } from 'vitest';
import {
  enableAgentExchangeLog,
  describeDebugExchange,
  logAgentExchange,
} from '../../../../src/desktop/worker/agent/AgentExchangeLog.js';

it('shows readable requests, parsed tool arguments and native refusals without media or credentials', () => {
  const result = describeDebugExchange({
    input: 'Làm sao mở YouTube?',
    arguments: JSON.stringify({
      steps: [{ kind: 'circle', center: { x: 0.5, y: 0.98 } }],
      token: 'synthetic-token',
    }),
    output: [
      { type: 'text', text: 'invalid_request' },
      { type: 'image', data: 'synthetic-screenshot' },
    ],
    headers: { authorization: 'synthetic-secret' },
    text: 'Bearer synthetic-credential sk-synthetickey password=synthetic-password',
  });
  const serialized = JSON.stringify(result);
  expect(serialized).toContain('Làm sao mở YouTube?');
  expect(serialized).toContain('invalid_request');
  expect(serialized).toContain('0.98');
  for (const secret of [
    'synthetic-token',
    'synthetic-screenshot',
    'synthetic-secret',
    'synthetic-credential',
    'sk-synthetickey',
    'synthetic-password',
  ]) {
    expect(serialized).not.toContain(secret);
  }
});

it('bounds cyclic values, item counts and long messages', () => {
  const value: { self?: unknown } = {};
  value.self = value;
  expect(JSON.stringify(describeDebugExchange(value))).toContain('[truncated]');
  expect(JSON.stringify(describeDebugExchange('a'.repeat(10_000))).length).toBeLessThan(6100);
  expect(
    JSON.stringify(describeDebugExchange(Array.from({ length: 1000 }, () => 'item'))),
  ).toContain('[truncated items]');
});

it('emits paired input/output/error only with development debug enabled', () => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });
  const exchange = {
    operation: 'native.tool',
    input: { steps: [] },
    output: { isError: true },
    error: 'invalid_request',
  };
  logAgentExchange(pino({ level: 'info' }, stream), exchange);
  expect(chunks).toEqual([]);
  const debugLog = pino({ level: 'debug' }, stream);
  logAgentExchange(debugLog, exchange);
  expect(chunks).toEqual([]);
  enableAgentExchangeLog(debugLog);
  logAgentExchange(debugLog, exchange);
  expect(chunks.join('')).toContain('agent.debug.exchange');
  expect(chunks.join('')).toContain('invalid_request');
  expect(chunks.join('')).toContain('"input":');
  expect(chunks.join('')).toContain('"output":');
});
