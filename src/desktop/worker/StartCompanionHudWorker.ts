import { MCPServerStdio } from '@openai/agents';
import type { TeachingMessage } from '#contracts/TeachingStep.js';
import {
  CompanionHudAckSchema,
  CompanionHudTool,
  type CompanionHudSnapshot,
} from '#contracts/CompanionHud.js';
import {
  CompanionHudMessageSchema,
  CompanionHudWorkerCommandSchema,
} from '#contracts/CompanionHudWorker.js';

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
        let reading = false;
        let previousMessage = '';
        const reportMessage = (message: TeachingMessage | null): void => {
          const identity = JSON.stringify(message);
          if (identity !== previousMessage) {
            previousMessage = identity;
            parentPort.postMessage({ kind: 'message', message });
          }
        };
        const readingTimer = setInterval(() => {
          if (reading || !server || !group) {
            return;
          }
          reading = true;
          void server
            .callToolResult(CompanionHudTool.READ_MESSAGE, { group })
            .then((result) => {
              const parsed = CompanionHudMessageSchema.safeParse(result.structuredContent);
              reportMessage(result.isError || !parsed.success ? null : parsed.data.message);
            })
            .catch(() => {
              reportMessage(null);
            })
            .finally(() => {
              reading = false;
            });
        }, 150);
        readingTimer.unref();
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
