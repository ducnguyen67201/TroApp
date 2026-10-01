import { useEffect, useRef, useState } from 'react';
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
  messageInput: string;
  messages: TaskMessage[];
  message: string | null;
  setMessageInput: (value: string) => void;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  startNewTask: () => Promise<void>;
  sendMessage: () => Promise<void>;
}

/** App owns this controller so page navigation preserves the current task.
 * The preload bridge owns validation. Messages stay in memory and are never
 * sent as conversation history or saved to storage.
 */
export function useComputerUse(): ComputerUseController {
  const currentSessionId = useRef<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigning, setIsSigning] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

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
          setMessage(auth.message);
        }
      } catch {
        if (effectState.active) {
          setMessage('Could not check sign-in. Please try signing in again.');
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
        setMessage('Google sign-in did not finish. Please try again.');
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
        setMessage(result.kind === 'failed' ? result.message : 'Could not open Google sign-in.');
        setIsSigning(false);
      }
    } catch {
      setMessage('Could not open Google sign-in.');
      setIsSigning(false);
    }
  }

  async function startNewTask(): Promise<void> {
    if (isSending || isSigningOut || isResetting) {
      return;
    }
    setIsResetting(true);
    try {
      const sessionId = currentSessionId.current;
      if (sessionId) {
        const result = await window.tro.stopAgentSession(sessionId);
        if (result.kind !== 'stopped') {
          setMessage(result.kind === 'failed' ? result.message : 'Could not clear the task.');
          return;
        }
      }
      currentSessionId.current = null;
      setMessages([]);
      setMessageInput('');
      setMessage(null);
    } catch {
      setMessage('Could not clear the task. Please try again.');
    } finally {
      setIsResetting(false);
    }
  }

  async function sendMessage(): Promise<void> {
    if (!user || isSending || isSigningOut || isResetting || !messageInput.trim()) {
      return;
    }
    const submittedMessage = messageInput.trim();
    setIsSending(true);
    setMessage(null);
    try {
      let activeId = currentSessionId.current;
      if (!activeId) {
        const started = await window.tro.startAgentSession();
        if (started.kind !== 'started') {
          setMessage(started.kind === 'failed' ? started.message : 'Could not start a task.');
          return;
        }
        activeId = started.sessionId;
        currentSessionId.current = activeId;
      }
      setMessageInput('');
      const result = await window.tro.sendAgentMessage(activeId, submittedMessage);
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
        setMessage(result.kind === 'failed' ? result.message : 'Could not complete the task.');
        setMessageInput(submittedMessage);
      }
    } catch {
      setMessage('Could not contact the local agent. Try sending again.');
      setMessageInput(submittedMessage);
    } finally {
      setIsSending(false);
    }
  }

  async function signOut(): Promise<void> {
    if (isSending || isSigningOut || isResetting) {
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
        setMessage(result.kind === 'failed' ? result.message : 'Could not sign out.');
      }
    } catch {
      setMessage('Could not sign out. Please try again.');
    } finally {
      setIsSigningOut(false);
    }
  }

  return {
    user,
    isLoading,
    isSigning,
    isSigningOut,
    isSending,
    isResetting,
    messageInput,
    messages,
    message,
    setMessageInput,
    signInWithGoogle,
    signOut,
    startNewTask,
    sendMessage,
  };
}
