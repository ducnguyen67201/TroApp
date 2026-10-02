import { VoiceState, type VoiceEvent } from '#contracts/VoiceInput.js';
import { useEffect, useRef, useState } from 'react';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { useLocale } from './localization/UseLocale.js';
import { resolveBridgeError } from './localization/BridgeErrors.js';
import type { TranslationKey } from './localization/English.js';
import type { AuthUser } from '#contracts/AuthSession.js';

export const MessageRole = { USER: 'user', AGENT: 'agent' } as const;

interface TaskMessage {
  role: (typeof MessageRole)[keyof typeof MessageRole];
  text: string;
}

export interface ComputerUseController {
  user: AuthUser | null;
  isLoading: boolean;
  isSigning: boolean;
  isSigningOut: boolean;
  isSending: boolean;
  isResetting: boolean;
  taskMode: AgentTaskMode;
  setTaskMode: (mode: AgentTaskMode) => void;
  stopTask: () => Promise<void>;
  messageInput: string;
  messages: TaskMessage[];
  message: string | null;
  setMessageInput: (value: string) => void;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  startNewTask: () => Promise<void>;
  sendMessage: (instruction?: string) => Promise<void>;
  receiveVoiceEvent: (event: VoiceEvent) => void;
}

/** App owns this controller so page navigation preserves the current task.
 * The preload bridge owns validation. Messages stay in memory and are never
 * sent as conversation history or saved to storage.
 */
export function useComputerUse(): ComputerUseController {
  const { messages: translations, locale } = useLocale();
  const currentSessionId = useRef<string | null>(null);
  const taskGeneration = useRef(0);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigning, setIsSigning] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [taskMode, setTaskMode] = useState<AgentTaskMode>(AgentTaskMode.TEACH);
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [message, setMessage] = useState<TranslationKey | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isVoiceBusy, setIsVoiceBusy] = useState(false);
  const voiceCaptureId = useRef<string | null>(null);

  useEffect(() => {
    const effectState = { active: true };
    void (async () => {
      try {
        const auth = await window.tro.readAuthSession();
        if (!effectState.active) {
          return;
        }
        if (auth.kind === 'signed-in') {
          setUser(auth.user);
        } else if (auth.kind === 'failed') {
          setMessage(resolveBridgeError(auth.message, 'errorCheckSignIn'));
        }
      } catch {
        if (effectState.active) {
          setMessage('errorCheckSignIn');
        }
      } finally {
        if (effectState.active) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      effectState.active = false;
    };
  }, []);

  useEffect(() => {
    if (!isSigning) {
      return;
    }
    /* Google returns through the existing system-browser deep link. Poll the
       narrow session bridge with one read at a time and a two-minute deadline. */
    let active = true;
    const deadline = Date.now() + 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function checkSignIn(): Promise<void> {
      try {
        const result = await window.tro.readAuthSession();
        if (!active) {
          return;
        }
        if (result.kind === 'signed-in') {
          setUser(result.user);
          setIsSigning(false);
          setMessage(null);
          return;
        }
      } catch {
        /* A transient status failure can recover before the attempt expires. */
      }
      if (!active) {
        return;
      }
      if (Date.now() >= deadline) {
        setIsSigning(false);
        setMessage('errorSignInTimeout');
        return;
      }
      timer = setTimeout(() => void checkSignIn(), 1000);
    }

    timer = setTimeout(() => void checkSignIn(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [isSigning]);

  async function signInWithGoogle(): Promise<void> {
    if (isLoading || isSigning || isSigningOut) {
      return;
    }
    setIsSigning(true);
    setMessage(null);
    try {
      const result = await window.tro.signInWithGoogle();
      if (result.kind === 'signed-in') {
        setUser(result.user);
        setIsSigning(false);
      } else if (result.kind !== 'pending') {
        setMessage(
          result.kind === 'failed'
            ? resolveBridgeError(result.message, 'errorOpenGoogle')
            : 'errorOpenGoogle',
        );
        setIsSigning(false);
      }
    } catch {
      setMessage('errorOpenGoogle');
      setIsSigning(false);
    }
  }

  async function startNewTask(): Promise<void> {
    if (isSending || isVoiceBusy || isSigningOut || isResetting) {
      return;
    }
    setIsResetting(true);
    try {
      await window.tro.controlVoiceInput({ kind: 'cancel' });
      const sessionId = currentSessionId.current;
      if (sessionId) {
        const result = await window.tro.stopAgentSession(sessionId);
        if (result.kind !== 'stopped') {
          setMessage(
            result.kind === 'failed'
              ? resolveBridgeError(result.message, 'errorClearTask')
              : 'errorClearTask',
          );
          return;
        }
      }
      currentSessionId.current = null;
      setMessages([]);
      setMessageInput('');
      setMessage(null);
    } catch {
      setMessage('errorClearTask');
    } finally {
      setIsResetting(false);
    }
  }

  async function sendMessage(instruction: string = messageInput): Promise<void> {
    if (!user || isSending || isVoiceBusy || isSigningOut || isResetting || !instruction.trim()) {
      return;
    }
    const submittedMessage = instruction.trim();
    const generation = taskGeneration.current;
    setIsSending(true);
    setMessage(null);
    try {
      let activeId = currentSessionId.current;
      if (!activeId) {
        const started = await window.tro.startAgentSession();
        if (taskGeneration.current !== generation) {
          return;
        }
        if (started.kind !== 'started') {
          setMessage(
            started.kind === 'failed'
              ? resolveBridgeError(started.message, 'errorStartTask')
              : 'errorStartTask',
          );
          return;
        }
        activeId = started.sessionId;
        currentSessionId.current = activeId;
      }
      setMessageInput('');
      const result = await window.tro.sendAgentMessage(
        activeId,
        submittedMessage,
        locale,
        taskMode,
      );
      if (currentSessionId.current !== activeId) {
        return;
      }
      if (result.kind === 'completed') {
        setMessages((current) => [
          ...current,
          { role: MessageRole.USER, text: submittedMessage },
          { role: MessageRole.AGENT, text: result.answer },
        ]);
      } else {
        setMessage(
          result.kind === 'failed'
            ? resolveBridgeError(result.message, 'errorCompleteTask')
            : 'errorCompleteTask',
        );
        setMessageInput(submittedMessage);
      }
    } catch {
      if (taskGeneration.current === generation) {
        setMessage('errorContactAgent');
        setMessageInput(submittedMessage);
      }
    } finally {
      setIsSending(false);
    }
  }

  async function stopTask(): Promise<void> {
    const sessionId = currentSessionId.current;
    if (isResetting) {
      return;
    }
    taskGeneration.current += 1;
    setIsResetting(true);
    /* Invalidate the pending reply before awaiting stop, so cancellation
       cannot append a late answer or restore the canceled message. */
    currentSessionId.current = null;
    try {
      if (sessionId) {
        const result = await window.tro.stopAgentSession(sessionId);
        if (result.kind !== 'stopped') {
          setMessage('errorClearTask');
        }
      }
    } catch {
      setMessage('errorClearTask');
    } finally {
      setIsResetting(false);
    }
  }

  async function signOut(): Promise<void> {
    if (isSending || isVoiceBusy || isSigningOut || isResetting) {
      return;
    }
    setIsSigningOut(true);
    try {
      const result = await window.tro.signOut();
      if (result.kind === 'signed-out') {
        setUser(null);
        currentSessionId.current = null;
        setMessages([]);
        setMessageInput('');
        setMessage(null);
      } else {
        setMessage(
          result.kind === 'failed'
            ? resolveBridgeError(result.message, 'errorSignOut')
            : 'errorSignOut',
        );
      }
    } catch {
      setMessage('errorSignOut');
    } finally {
      setIsSigningOut(false);
    }
  }

  function receiveVoiceEvent(event: VoiceEvent): void {
    if (event.kind === 'status') {
      const busy =
        event.status.state !== VoiceState.IDLE && event.status.state !== VoiceState.DISABLED;
      setIsVoiceBusy(busy);
    } else if (event.kind === 'submitted') {
      voiceCaptureId.current = event.captureId;
      currentSessionId.current = event.sessionId;
      setMessage(null);
      setMessages((current) => [...current, { role: MessageRole.USER, text: event.text }]);
    } else if (
      event.kind === 'result' &&
      voiceCaptureId.current === event.captureId &&
      currentSessionId.current === event.sessionId
    ) {
      voiceCaptureId.current = null;
      if (event.result.kind === 'completed') {
        const answer = event.result.answer;
        setMessages((current) => [...current, { role: MessageRole.AGENT, text: answer }]);
      } else {
        setMessage(
          event.result.kind === 'failed'
            ? resolveBridgeError(event.result.message, 'errorCompleteTask')
            : 'errorCompleteTask',
        );
      }
    }
  }

  return {
    user,
    isLoading,
    isSigning,
    isSigningOut,
    isSending: isSending || isVoiceBusy,
    isResetting,
    taskMode,
    setTaskMode,
    stopTask,
    messageInput,
    messages,
    message: message ? translations[message] : null,
    setMessageInput,
    signInWithGoogle,
    signOut,
    startNewTask,
    sendMessage,
    receiveVoiceEvent,
  };
}
