import { MCPServerStdio } from '@openai/agents';
import {
  CompanionHudAckSchema,
  CompanionHudTool,
  type CompanionHudSnapshot,
} from '#contracts/CompanionHud.js';
import { CompanionHudWorkerCommandSchema } from '#contracts/CompanionHudWorker.js';

const parentPort = process.parentPort;
let server: MCPServerStdio | null = null;
let group: string | null = null;
let latest: CompanionHudSnapshot | null = null;
let revision = 0;
let sentRevision = -1;
let sequence = 0;
let pumping = false;

/** Coalesce to a single latest snapshot, with one native call in flight. */
async function publishLatest(): Promise<void> {
  if (pumping || !server || !group || !latest) {
    return;
  }
  pumping = true;
  try {
    while (revision !== sentRevision) {
      const sendingRevision = revision;
      const result = await server.callToolResult(CompanionHudTool.SET_STATE, {
        group,
        sequence: sequence++,
        ...latest,
      });
      const ack = CompanionHudAckSchema.safeParse(result.structuredContent);
      if (result.isError || !ack.success || !ack.data.applied) {
        throw new Error('Native presentation unavailable.');
      }
      sentRevision = sendingRevision;
    }
  } catch {
    parentPort.postMessage({ ready: false });
    await server.close().catch(() => {});
  } finally {
    pumping = false;
  }
}

parentPort.on('message', (event) => {
  const command = CompanionHudWorkerCommandSchema.safeParse(event.data);
  if (!command.success) {
    return;
  }
  latest = command.data.snapshot;
  revision += 1;
  if (command.data.kind === 'snapshot') {
    void publishLatest();
    return;
  }
  if (group) {
    return;
  }
  const connection = command.data.desktopDriver;
  group = command.data.group;
  void (async () => {
    try {
      server = new MCPServerStdio({
        name: 'Tro presentation',
        ...connection,
        cacheToolsList: true,
      });
      await server.connect();
      await publishLatest();
      if (sentRevision >= 0) {
        parentPort.postMessage({ ready: true });
        const renewal = setInterval(() => {
          revision += 1;
          void publishLatest();
        }, 5000);
        renewal.unref();
      }
    } catch {
      parentPort.postMessage({ ready: false });
      await server?.close().catch(() => {});
    }
  })();
});
