import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LessonCommand,
  LessonVideoFailure,
  type LessonVideo,
  type LessonVideoCommand,
  type LessonVideoReply,
} from '#contracts/LessonVideos.js';

import { isLessonGenerating } from './LessonVideoLabels.js';

type Options = Extract<LessonVideoReply, { kind: 'options' }>;

export function useLessonVideo(): {
  options: Options | null;
  lessons: LessonVideo[];
  selected: LessonVideo | null;
  busy: boolean;
  loading: boolean;
  error: (typeof LessonVideoFailure)[keyof typeof LessonVideoFailure] | null;
  select: (lesson: LessonVideo | null) => void;
  execute: (
    command: LessonVideoCommand,
    onAcknowledged?: (reply: LessonVideoReply) => void,
  ) => Promise<void>;
} {
  const [options, setOptions] = useState<Options | null>(null);
  const [lessons, setLessons] = useState<LessonVideo[]>([]);
  const [selected, setSelected] = useState<LessonVideo | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [error, setError] = useState<
    (typeof LessonVideoFailure)[keyof typeof LessonVideoFailure] | null
  >(null);
  const epoch = useRef(0);
  const selectionEpoch = useRef(0);
  const alive = useRef(true);
  const execute = useCallback(
    async (
      command: LessonVideoCommand,
      onAcknowledged?: (reply: LessonVideoReply) => void,
    ): Promise<void> => {
      const generation = ++epoch.current;
      const selection = selectionEpoch.current;
      setBusy(true);
      setError(null);
      try {
        const reply = await window.tro.controlLessonVideos?.(command);
        if (!alive.current || generation !== epoch.current) {
          return;
        }
        // Main also maps lost HTTP replies to UNAVAILABLE; keep their idempotency key for retry.
        if (reply && (reply.kind !== 'failed' || reply.code !== LessonVideoFailure.UNAVAILABLE)) {
          onAcknowledged?.(reply);
        }
        if (!reply || reply.kind === 'failed') {
          setError(reply?.code ?? LessonVideoFailure.UNAVAILABLE);
          return;
        }
        if (reply.kind === 'options') {
          setOptions(reply);
        }
        if (reply.kind === 'list') {
          setLessons(reply.lessons);
        }
        if (reply.kind === 'lesson') {
          if (selection === selectionEpoch.current) {
            setSelected(reply.lesson);
          }
          setLessons((current) => [
            reply.lesson,
            ...current.filter((item) => item.id !== reply.lesson.id),
          ]);
        }
        if (reply.kind === 'ok' && command.kind === LessonCommand.DELETE) {
          setSelected((current) => (current?.id === command.id ? null : current));
          setLessons((current) => current.filter((item) => item.id !== command.id));
        }
      } catch {
        if (alive.current && generation === epoch.current) {
          setError(LessonVideoFailure.UNAVAILABLE);
        }
      } finally {
        if (alive.current && generation === epoch.current) {
          setBusy(false);
        }
      }
    },
    [],
  );
  useEffect(() => {
    alive.current = true;
    void (async () => {
      await execute({ kind: LessonCommand.OPTIONS });
      if (alive.current) {
        await execute({ kind: LessonCommand.LIST });
      }
      if (alive.current) {
        setLoading(false);
      }
    })();
    return () => {
      alive.current = false;
      epoch.current += 1;
    };
  }, [execute]);
  useEffect(() => {
    if (busy || loading) {
      return;
    }
    const selectedActive = selected && isLessonGenerating(selected);
    const hasActiveLessons = lessons.some(isLessonGenerating);
    if (!selectedActive && !hasActiveLessons) {
      return;
    }
    const generation = epoch.current;
    const selection = selectionEpoch.current;
    let disposed = false;
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            // One list refresh keeps every background card current, including behind an open dialog.
            const reply = await window.tro.controlLessonVideos?.({ kind: LessonCommand.LIST });
            if (disposed || !alive.current || generation !== epoch.current) {
              return;
            }
            if (reply?.kind !== 'list') {
              setPollAttempt((current) => current + 1);
              return;
            }
            setLessons(reply.lessons);
            if (selection === selectionEpoch.current) {
              setSelected((current) =>
                current ? (reply.lessons.find((item) => item.id === current.id) ?? current) : null,
              );
            }
            setPollAttempt(0);
          } catch {
            if (!disposed && alive.current && generation === epoch.current) {
              setPollAttempt((current) => current + 1);
            }
          }
        })();
      },
      pollAttempt > 0 ? 6000 : selectedActive ? 2000 : 5000,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selected, busy, loading, lessons, execute, pollAttempt]);
  return {
    options,
    lessons,
    selected,
    busy,
    loading,
    error,
    execute,
    select: (lesson) => {
      selectionEpoch.current += 1;
      setError(null);
      setSelected(lesson);
    },
  };
}
