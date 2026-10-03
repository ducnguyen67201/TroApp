import { AgentCommandSchema, type AgentResult } from '#contracts/AgentSession.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { AgentChatController } from './AgentChatController.js';

export interface AgentCommandPorts {
  chat: AgentChatController;
  startFollowing(): Promise<AgentResult>;
  canSendMessage(): boolean;
  startTask: (sessionId: string, locale: DesktopLocale) => void;
  finishTask: (result: AgentResult, sessionId: string) => void;
  cancelPresentation: () => void;
}

/** Dispatch validated commands after the IPC owner has verified the sender.
 * UI presentation and voice policy stay in main; task state belongs to chat. */
export async function executeAgentCommand(
  rawCommand: unknown,
  ports: AgentCommandPorts,
): Promise<AgentResult> {
  const parsed = AgentCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return { kind: 'failed', message: 'The agent request is invalid.' };
  }
  const command = parsed.data;
  switch (command.kind) {
    case 'locale':
      return ports.chat.updateTeachingLocale(command.sessionId, command.locale);
    case 'follow':
      return ports.startFollowing();
    case 'start':
      return ports.chat.startTaskSession();
    case 'turn': {
      if (!ports.canSendMessage()) {
        return { kind: 'failed', message: 'Wait for the current task to finish.' };
      }
      ports.startTask(command.sessionId, command.locale);
      const result = await ports.chat.sendMessage(
        command.sessionId,
        command.message,
        command.locale,
        command.mode,
      );
      ports.finishTask(result, command.sessionId);
      return result;
    }
    case 'answer':
      return ports.chat.answerLesson(
        command.sessionId,
        command.lessonId,
        command.message,
        command.locale,
      );
    case 'stop':
      ports.cancelPresentation();
      return ports.chat.stopSession(command.sessionId);
  }
}
