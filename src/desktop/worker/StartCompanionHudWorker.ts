import { IdleCursorFollowing } from './companion/IdleCursorFollowing.js';
import { MCPServerStdio } from '@openai/agents';
import type { TeachingMessage } from '#contracts/TeachingStep.js';
import { CompanionHudAckSchema, CompanionHudTool } from '#contracts/CompanionHud.js';
import {
  CompanionHudMessageSchema,
  CompanionHudWorkerCommandSchema,
} from '#contracts/CompanionHudWorker.js';
import { CompanionHudPublisher } from './companion/CompanionHudPublisher.js';

const parentPort = process.parentPort;
let server: MCPServerStdio | null = null;
let publisher: CompanionHudPublisher | null = null;
let connecting = false;
let cursor: IdleCursorFollowing | null = null;

function stopPresentation(): void {
  cursor?.dispose();
  publisher?.dispose();
  parentPort.postMessage({ ready: false });
  void server?.close().catch(() => {});
}

parentPort.on('message', (event) => {
  const parsed = CompanionHudWorkerCommandSchema.safeParse(event.data);
  if (!parsed.success) {
    return;
  }
  const command = parsed.data;
  if (command.kind === 'following') {
    void (async () => {
      try {
        if (!cursor) {
          throw new Error('Cursor transport is unavailable.');
        }
        await cursor.setEnabled(command.enabled);
        parentPort.postMessage({ kind: 'following', requestId: command.requestId, applied: true });
      } catch {
        parentPort.postMessage({ kind: 'following', requestId: command.requestId, applied: false });
      }
    })();
    return;
  }
  if (command.kind === 'snapshot') {
    try {
      publisher?.updateSnapshot(command.snapshot);
      void publisher?.flush().catch(stopPresentation);
    } catch {
      stopPresentation();
    }
    return;
  }
  if (connecting) {
    return;
  }
  connecting = true;
  const group = command.group;
  void (async () => {
    try {
      const connection = new MCPServerStdio({
        name: 'Tro presentation',
        ...command.desktopDriver,
        cacheToolsList: true,
      });
      server = connection;
      await connection.connect();
      const initial = await connection.callToolResult(CompanionHudTool.SET_STATE, {
        group,
        sequence: 0,
        phase: command.snapshot.phase,
        locale: command.snapshot.locale,
        level: command.snapshot.level,
        speakingSequence: command.snapshot.speakingSequence ?? null,
      });
      if (initial.isError || !CompanionHudAckSchema.parse(initial.structuredContent).applied) {
        throw new Error('Native presentation unavailable.');
      }
      const publication = new CompanionHudPublisher(group, {
        async sendCommand(nativeCommand) {
          const result = await connection.callToolResult(
            CompanionHudTool.SEND_COMMAND,
            nativeCommand,
          );
          if (result.isError) {
            throw new Error('Native presentation unavailable.');
          }
          return CompanionHudAckSchema.parse(result.structuredContent);
        },
      });
      publisher = publication;
      publication.updateSnapshot(command.snapshot);
      await publication.flush();
      const binding = await connection.callToolResult(CompanionHudTool.BIND_CURSOR, { group });
      if (binding.isError) {
        throw new Error('Cursor binding unavailable.');
      }
      cursor = new IdleCursorFollowing(connection, stopPresentation);
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
        if (reading) {
          return;
        }
        reading = true;
        const observationRevision = publication.readObservationRevision();
        void connection
          .callToolResult(CompanionHudTool.READ_MESSAGE, { group })
          .then((result) => {
            const reply = CompanionHudMessageSchema.safeParse(result.structuredContent);
            if (!result.isError && reply.success) {
              if (publication.observeMessage(reply.data, observationRevision)) {
                reportMessage(reply.data.message);
              }
            } else {
              reportMessage(null);
            }
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
        try {
          publication.renewLease();
          void publication.flush().catch(stopPresentation);
        } catch {
          stopPresentation();
        }
      }, 5000);
      renewal.unref();
    } catch {
      stopPresentation();
    }
  })();
});
