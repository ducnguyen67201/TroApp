import { DesktopAccountLimits, type SavedAccounts } from '#contracts/DesktopAccounts.js';
import { AgentProgressPhase } from '#contracts/CompanionHud.js';
import { VoiceState, type VoiceEvent } from '#contracts/VoiceInput.js';
import { useEffect, useRef, useState } from 'react';
import { describeTeachingResult } from './TeachingResultPresentation.js';
import { AgentTaskMode, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { useLocale } from './localization/UseLocale.js';
import { resolveBridgeError } from './localization/BridgeErrors.js';
import type { TranslationKey } from './localization/English.js';
import type { AuthUser } from '#contracts/AuthSession.js';
import type { AgentCompletion } from '#contracts/TaskOutcome.js';

export const MessageRole = { USER: 'user', AGENT: 'agent' } as const;

interface TaskMessage {
  role: (typeof MessageRole)[keyof typeof MessageRole];
  text: string;
  outcome?: TeachingOutcome;
  completion?: AgentCompletion;
}

export interface ComputerUseController {
  user: AuthUser | null;
  isLoading: boolean;
  isSigning: boolean;
  isSigningOut: boolean;
  isSwitchingAccount: boolean;
  savedAccounts: SavedAccounts | null;
  refreshAccounts: () => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  addGoogleAccount: () => Promise<void>;
  cancelAccountSignIn: () => Promise<void>;
  isSending: boolean;
  isResetting: boolean;
  taskMode: AgentTaskMode;
  teachingStep: string | null;
  teachingPhase: AgentProgressPhase | null;
  canAnswerLesson: boolean;
  setTaskMode: (mode: AgentTaskMode) => void;
  stopTask: () => Promise<void>;
  messageInput: string;
  messages: TaskMessage[];
  message: string | null;
  setMessageInput: (value: string) => void;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  startNewTask: () => Promise<void>;
  preparePracticeHelp?: (instruction: string) => Promise<boolean>;
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
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccounts | null>(null);
  const accountOperation = useRef(false);
  const accountGeneration = useRef(0);
  const [taskMode, setTaskMode] = useState<AgentTaskMode>(AgentTaskMode.TEACH);
  const [messageInput, setMessageInput] = useState('');
  const [answerLessonId, setAnswerLessonId] = useState<string | null>(null);
  const [teachingPhase, setTeachingPhase] = useState<AgentProgressPhase | null>(null);
  const [teachingStep, setTeachingStep] = useState<string | null>(null);
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [message, setMessage] = useState<TranslationKey | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isVoiceLessonActive, setIsVoiceLessonActive] = useState(false);
  const [isVoiceBusy, setIsVoiceBusy] = useState(false);
  const voiceCaptureId = useRef<string | null>(null);

  useEffect(() => {
    const sessionId = currentSessionId.current;
    if (sessionId) {
      void window.tro.updateTeachingLocale?.(sessionId, locale).catch(() => {});
    }
  }, [locale]);

  useEffect(
    () =>
      window.tro.subscribeAgentProgress((progress) => {
        if (progress.sessionId === currentSessionId.current) {
          setTeachingPhase(progress.phase);
        }
        if (
          progress.sessionId === currentSessionId.current &&
          progress.phase === AgentProgressPhase.THINKING
        ) {
          setAnswerLessonId(null);
        }
        if (progress.sessionId === currentSessionId.current && progress.teachingStep) {
          setTeachingStep(progress.teachingStep);
          setAnswerLessonId(
            progress.phase === AgentProgressPhase.NEEDS_INPUT ||
              progress.phase === AgentProgressPhase.PAUSED
              ? (progress.lessonId ?? null)
              : null,
          );
        }
      }),
    [],
  );

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
          void refreshAccounts();
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
    const deadline = Date.now() + DesktopAccountLimits.SIGN_IN_TIMEOUT_MS;
    const generation = accountGeneration.current;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function checkSignIn(): Promise<void> {
      try {
        const result = await window.tro.readAuthSession();
        if (!active || generation !== accountGeneration.current) {
          return;
        }
        if (result.kind === 'signed-in') {
          setUser(result.user);
          setIsSigning(false);
          setMessage(null);
          void refreshAccounts();
          return;
        }
        if (result.kind === 'failed') {
          const error = resolveBridgeError(result.message, 'errorOpenGoogle');
          if (
            error === 'errorAccountStorage' ||
            error === 'errorAccountExpired' ||
            error === 'errorAccountLimit' ||
            error === 'errorSignInTimeout'
          ) {
            await cancelAccountSignIn();
            if (generation + 1 === accountGeneration.current) {
              setMessage(error);
            }
            return;
          }
        }
        if (result.kind === 'signed-out') {
          setIsSigning(false);
          setMessage('errorOpenGoogle');
          return;
        }
      } catch {
        /* A transient status failure can recover before the attempt expires. */
      }
      if (!active) {
        return;
      }
      if (Date.now() >= deadline) {
        await cancelAccountSignIn();
        if (generation + 1 === accountGeneration.current) {
          setMessage('errorSignInTimeout');
        }
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

  function clearAccountTask(): void {
    taskGeneration.current += 1;
    currentSessionId.current = null;
    voiceCaptureId.current = null;
    setMessages([]);
    setMessageInput('');
    setTeachingStep(null);
    setTeachingPhase(null);
    setAnswerLessonId(null);
    setIsVoiceLessonActive(false);
    setIsVoiceBusy(false);
    setMessage(null);
  }

  async function refreshAccounts(): Promise<void> {
    if (!window.tro.readSavedAccounts) {
      return;
    }
    const generation = accountGeneration.current;
    try {
      const result = await window.tro.readSavedAccounts();
      if (generation !== accountGeneration.current) {
        return;
      }
      if (result.kind === 'accounts') {
        setSavedAccounts(result);
      } else if (result.kind === 'failed') {
        setMessage(resolveBridgeError(result.message, 'errorSavedAccounts'));
      }
    } catch {
      if (generation === accountGeneration.current) {
        setMessage('errorSavedAccounts');
      }
    }
  }

  function canChangeAccount(): boolean {
    return (
      !accountOperation.current &&
      !isLoading &&
      !isSigning &&
      !isSigningOut &&
      !isSwitchingAccount &&
      !isSending &&
      !isVoiceBusy &&
      !isVoiceLessonActive &&
      !isResetting
    );
  }

  async function openGoogleAccount(addAccount: boolean): Promise<void> {
    if (!canChangeAccount()) {
      return;
    }
    accountOperation.current = true;
    accountGeneration.current += 1;
    clearAccountTask();
    setIsSigning(true);
    try {
      const result =
        addAccount && window.tro.addGoogleAccount
          ? await window.tro.addGoogleAccount()
          : await window.tro.signInWithGoogle();
      if (result.kind === 'signed-in') {
        setUser(result.user);
        setIsSigning(false);
        await refreshAccounts();
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
    } finally {
      accountOperation.current = false;
    }
  }

  function signInWithGoogle(): Promise<void> {
    return openGoogleAccount(false);
  }

  function addGoogleAccount(): Promise<void> {
    return openGoogleAccount(true);
  }

  async function cancelAccountSignIn(): Promise<void> {
    if (accountOperation.current) {
      return;
    }
    if (!window.tro.cancelAccountSignIn) {
      accountGeneration.current += 1;
      setIsSigning(false);
      return;
    }
    accountOperation.current = true;
    accountGeneration.current += 1;
    setIsSwitchingAccount(true);
    try {
      const result = await window.tro.cancelAccountSignIn();
      setIsSigning(false);
      if (result.kind === 'signed-in') {
        setUser(result.user);
      } else if (result.kind === 'signed-out') {
        setUser(null);
      } else if (result.kind === 'failed') {
        setMessage(resolveBridgeError(result.message, 'errorSwitchAccount'));
      }
      await refreshAccounts();
    } catch {
      setIsSigning(false);
      setMessage('errorSwitchAccount');
    } finally {
      accountOperation.current = false;
      setIsSwitchingAccount(false);
    }
  }

  async function switchAccount(accountId: string): Promise<void> {
    if (!canChangeAccount() || !window.tro.switchAccount) {
      return;
    }
    accountOperation.current = true;
    accountGeneration.current += 1;
    clearAccountTask();
    setIsSwitchingAccount(true);
    try {
      const result = await window.tro.switchAccount(accountId);
      if (result.kind === 'signed-in') {
        setUser(result.user);
      } else {
        setMessage(
          result.kind === 'failed'
            ? resolveBridgeError(result.message, 'errorSwitchAccount')
            : 'errorSwitchAccount',
        );
      }
      await refreshAccounts();
    } catch {
      setMessage('errorSwitchAccount');
    } finally {
      accountOperation.current = false;
      setIsSwitchingAccount(false);
    }
  }

  async function startNewTask(): Promise<void> {
    if (
      isSending ||
      isVoiceBusy ||
      isVoiceLessonActive ||
      isSigning ||
      isSwitchingAccount ||
      isSigningOut ||
      isResetting
    ) {
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
      setAnswerLessonId(null);
      setMessage(null);
    } catch {
      setMessage('errorClearTask');
    } finally {
      setIsResetting(false);
    }
  }

  async function preparePracticeHelp(instruction: string): Promise<boolean> {
    if (
      isSending ||
      isVoiceBusy ||
      isVoiceLessonActive ||
      isSigning ||
      isSwitchingAccount ||
      isSigningOut ||
      isResetting
    ) {
      return false;
    }
    await startNewTask();
    if (currentSessionId.current !== null) {
      return false;
    }
    setTaskMode(AgentTaskMode.TEACH);
    setMessageInput(instruction);
    return true;
  }

  async function sendMessage(instruction: string = messageInput): Promise<void> {
    const sessionId = currentSessionId.current;
    if (
      user &&
      sessionId &&
      answerLessonId &&
      instruction.trim() &&
      !isVoiceBusy &&
      !isResetting &&
      !isSigningOut &&
      !isSigning &&
      !isSwitchingAccount
    ) {
      const submittedAnswer = instruction.trim();
      let result: Awaited<ReturnType<typeof window.tro.answerTeachingLesson>>;
      try {
        result = await window.tro.answerTeachingLesson(
          sessionId,
          answerLessonId,
          submittedAnswer,
          locale,
        );
      } catch {
        setMessage('errorContactAgent');
        return;
      }
      if (currentSessionId.current !== sessionId) {
        return;
      }
      if (result.kind === 'accepted') {
        setAnswerLessonId(null);
        setMessageInput('');
        setMessages((current) => [...current, { role: MessageRole.USER, text: submittedAnswer }]);
      } else if (result.kind === 'failed') {
        setMessage(resolveBridgeError(result.message, 'errorCompleteTask'));
      }
      return;
    }
    if (
      !user ||
      isSending ||
      isVoiceBusy ||
      isVoiceLessonActive ||
      isSigningOut ||
      isSigning ||
      isSwitchingAccount ||
      isResetting ||
      !instruction.trim()
    ) {
      return;
    }
    const submittedMessage = instruction.trim();
    const generation = taskGeneration.current;
    setIsSending(true);
    setTeachingStep(null);
    setTeachingPhase(null);
    setAnswerLessonId(null);
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
      setMessages((current) => [...current, { role: MessageRole.USER, text: submittedMessage }]);
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
          { role: MessageRole.AGENT, text: result.answer, completion: result.completion },
        ]);
      } else if (result.kind === 'teaching') {
        setMessages((current) => [
          ...current,
          {
            role: MessageRole.AGENT,
            text: describeTeachingResult(result.result, translations),
            outcome: result.result.outcome,
          },
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
      setTeachingStep(null);
      setTeachingPhase(null);
      setAnswerLessonId(null);
    }
  }

  async function stopTask(): Promise<void> {
    const sessionId = currentSessionId.current;
    if (isResetting) {
      return;
    }
    taskGeneration.current += 1;
    setIsVoiceLessonActive(false);
    setTeachingStep(null);
    setTeachingPhase(null);
    setAnswerLessonId(null);
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

  useEffect(() => {
    if ((!isSending && !isVoiceBusy && !isVoiceLessonActive) || taskMode !== AgentTaskMode.TEACH) {
      return;
    }
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.repeat) {
        void stopTask();
      }
    };
    window.addEventListener('keydown', cancelOnEscape);
    return () => {
      window.removeEventListener('keydown', cancelOnEscape);
    };
  }, [isSending, isVoiceBusy, isVoiceLessonActive, taskMode, stopTask]);

  async function signOut(): Promise<void> {
    if (!canChangeAccount()) {
      return;
    }
    accountOperation.current = true;
    accountGeneration.current += 1;
    setIsSigningOut(true);
    try {
      const result = await window.tro.signOut();
      if (result.kind === 'signed-out') {
        setUser(null);
        clearAccountTask();
        await refreshAccounts();
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
      accountOperation.current = false;
      setIsSigningOut(false);
    }
  }

  function receiveVoiceEvent(event: VoiceEvent): void {
    if (isSigning || isSwitchingAccount || isSigningOut) {
      return;
    }
    if (
      event.kind === 'result' &&
      event.result.kind === 'accepted' &&
      event.sessionId === currentSessionId.current
    ) {
      voiceCaptureId.current = null;
      return;
    }
    if (event.kind === 'status') {
      const busy =
        event.status.state !== VoiceState.IDLE && event.status.state !== VoiceState.DISABLED;
      setIsVoiceBusy(busy);
    } else if (event.kind === 'submitted') {
      if (!isSending) {
        setIsVoiceLessonActive(true);
      }
      setTeachingStep(null);
      setTeachingPhase(null);
      setAnswerLessonId(null);
      voiceCaptureId.current = event.captureId;
      currentSessionId.current = event.sessionId;
      setMessage(null);
      setMessages((current) => [...current, { role: MessageRole.USER, text: event.text }]);
    } else if (
      event.kind === 'result' &&
      (voiceCaptureId.current === event.captureId ||
        (event.result.kind === 'teaching' &&
          (event.result.result.outcome === TeachingOutcome.GOAL_REACHED ||
            event.result.result.outcome === TeachingOutcome.FAILED ||
            event.result.result.outcome === TeachingOutcome.CANCELED))) &&
      currentSessionId.current === event.sessionId
    ) {
      voiceCaptureId.current = null;
      setIsVoiceLessonActive(false);
      setTeachingStep(null);
      setTeachingPhase(null);
      setAnswerLessonId(null);
      if (event.result.kind === 'completed') {
        const result = event.result;
        setMessages((current) => [
          ...current,
          { role: MessageRole.AGENT, text: result.answer, completion: result.completion },
        ]);
      } else if (event.result.kind === 'teaching') {
        const result = event.result.result;
        setMessages((current) => [
          ...current,
          {
            role: MessageRole.AGENT,
            text: describeTeachingResult(result, translations),
            outcome: result.outcome,
          },
        ]);
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
    isSwitchingAccount,
    savedAccounts,
    refreshAccounts,
    switchAccount,
    addGoogleAccount,
    cancelAccountSignIn,
    isSending: isSending || isVoiceBusy || isVoiceLessonActive,
    isResetting,
    taskMode,
    teachingStep,
    teachingPhase,
    canAnswerLesson: answerLessonId !== null,
    setTaskMode,
    stopTask,
    messageInput,
    messages,
    message: message ? translations[message] : null,
    setMessageInput,
    signInWithGoogle,
    signOut,
    startNewTask,
    preparePracticeHelp,
    sendMessage,
    receiveVoiceEvent,
  };
}
