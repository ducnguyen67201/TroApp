import { createInterface } from 'node:readline';
import { z } from 'zod';
import { TeachingFlowFixture } from './TeachingFlowFixture.js';

const endpoint = z.url().parse(process.argv[2]);
const rpcSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const fixture = new TeachingFlowFixture();
const lines = createInterface({ input: process.stdin });

/* A real stdio MCP peer. Only this independent wire fixture replaces native Cua. */
async function answerLine(line: string): Promise<void> {
  const raw: unknown = JSON.parse(line);
  const rpc = rpcSchema.parse(raw);
  if (rpc.id === undefined) {
    return;
  }
  let result: unknown;
  switch (rpc.method) {
    case 'initialize':
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'Teaching contract desktop', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = { tools: fixture.readTools() };
      break;
    case 'tools/call': {
      const response = await fetch(`${endpoint}/tools`, {
        method: 'POST',
        body: JSON.stringify(rpc.params),
      });
      result = await response.json();
      break;
    }
    case 'ping':
      result = {};
      break;
    default:
      throw new Error('Unexpected MCP method.');
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n`);
}

lines.on('line', (line) => {
  void answerLine(line).catch(() => {
    process.exitCode = 1;
    lines.close();
  });
});
lines.on('close', () => {
  void fetch(`${endpoint}/disconnect`, { method: 'POST', body: '{}' }).catch(() => {});
});

process.once('SIGTERM', () => {
  void fetch(`${endpoint}/disconnect`, { method: 'POST', body: '{}' }).finally(() =>
    process.exit(0),
  );
});
