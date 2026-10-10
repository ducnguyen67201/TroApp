import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GuidedLessonReplySchema,
  type GuidedLessonCommand,
  type GuidedLessonReadRequest,
  type GuidedLessonReply,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';

export interface GuidedLessonBridge {
  error: string | null;
  read: (request: GuidedLessonReadRequest, channel?: string) => Promise<GuidedLessonReply | null>;
  command: (command: GuidedLessonCommand) => Promise<GuidedLessonReply | null>;
  clearError: () => void;
}

/** Account/class fencing and per-query ordering reject late protected replies. */
export function useGuidedLessonBridge(scope: string): GuidedLessonBridge {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const [error, setError] = useState<string | null>(null);
  const current = useRef({ scope, generation: 0, sequences: new Map<string, number>() });
  if (current.current.scope !== scope) {
    current.current = { scope, generation: current.current.generation + 1, sequences: new Map() };
  }
  useEffect(() => {
    setError(null);
    return () => {
      current.current.generation += 1;
      current.current.sequences.clear();
    };
  }, [scope]);

  const acceptReply = useCallback(
    (reply: unknown): GuidedLessonReply | null => {
      const parsed = GuidedLessonReplySchema.safeParse(reply);
      if (!parsed.success) {
        setError(translate('Guided lessons could not be loaded. Try again.'));
        return null;
      }
      if (parsed.data.kind === 'failed') {
        setError(
          parsed.data.message || translate('Guided lessons could not be loaded. Try again.'),
        );
      } else {
        setError(null);
      }
      return parsed.data;
    },
    [translate],
  );

  const read = useCallback(
    async (
      request: GuidedLessonReadRequest,
      channel = 'read',
    ): Promise<GuidedLessonReply | null> => {
      const state = current.current;
      const generation = state.generation;
      const sequence = (state.sequences.get(channel) ?? 0) + 1;
      state.sequences.set(channel, sequence);
      const send = window.tro.readGuidedLessons;
      if (!send) {
        setError(translate('Guided lessons are unavailable in this app version.'));
        return null;
      }
      try {
        const reply = await send(request);
        if (
          current.current !== state ||
          state.generation !== generation ||
          state.sequences.get(channel) !== sequence
        ) {
          return null;
        }
        return acceptReply(reply);
      } catch {
        if (current.current === state && state.generation === generation) {
          setError(translate('Guided lessons could not be loaded. Try again.'));
        }
        return null;
      }
    },
    [acceptReply, translate],
  );

  const command = useCallback(
    async (command: GuidedLessonCommand): Promise<GuidedLessonReply | null> => {
      const state = current.current;
      const generation = state.generation;
      const send = window.tro.commandGuidedLesson;
      if (!send) {
        setError(translate('Guided lessons are unavailable in this app version.'));
        return null;
      }
      try {
        const reply = await send(command);
        if (current.current !== state || state.generation !== generation) {
          return null;
        }
        return acceptReply(reply);
      } catch {
        if (current.current === state && state.generation === generation) {
          setError(translate('Guided lessons could not be loaded. Try again.'));
        }
        return null;
      }
    },
    [acceptReply, translate],
  );

  return {
    error,
    read,
    command,
    clearError: useCallback(() => {
      setError(null);
    }, []),
  };
}
