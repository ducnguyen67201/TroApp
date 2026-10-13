import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LessonVideoStatus,
  LessonCommand,
  LessonVideoFailure,
  type LessonVideo,
  type LessonVideoCommand,
  type LessonVideoReply,
} from '#contracts/LessonVideos.js';

type Options = Extract<LessonVideoReply, { kind: 'options' }>;

export function useLessonVideo(): {
  options: Options | null;
  lessons: LessonVideo[];
  selected: LessonVideo | null;
  busy: boolean;
  error: (typeof LessonVideoFailure)[keyof typeof LessonVideoFailure] | null;
  select: (lesson: LessonVideo | null) => void;
  execute: (command: LessonVideoCommand, onAcknowledged?: () => void) => Promise<void>;
} {
  const [options, setOptions] = useState<Options | null>(null);
  const [lessons, setLessons] = useState<LessonVideo[]>([]);
  const [selected, setSelected] = useState<LessonVideo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<
    (typeof LessonVideoFailure)[keyof typeof LessonVideoFailure] | null
  >(null);
  const epoch = useRef(0);
  const alive = useRef(true);
  const execute = useCallback(
    async (command: LessonVideoCommand, onAcknowledged?: () => void): Promise<void> => {
      const generation = ++epoch.current;
      setBusy(true);
      setError(null);
      try {
        const reply = await window.tro.controlLessonVideos?.(command);
        if (!alive.current || generation !== epoch.current) {
          return;
        }
        // Main also maps lost HTTP replies to UNAVAILABLE; keep their idempotency key for retry.
        if (reply && (reply.kind !== 'failed' || reply.code !== LessonVideoFailure.UNAVAILABLE)) {
          onAcknowledged?.();
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
          setSelected(reply.lesson);
          setLessons((current) => [
            reply.lesson,
            ...current.filter((item) => item.id !== reply.lesson.id),
          ]);
        }
        if (reply.kind === 'ok' && command.kind === LessonCommand.DELETE) {
          setSelected(null);
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
    })();
    return () => {
      alive.current = false;
      epoch.current += 1;
    };
  }, [execute]);
  useEffect(() => {
    const active =
      selected &&
      (selected.status === LessonVideoStatus.RUNNING ||
        selected.status === LessonVideoStatus.QUEUED);
    if (!active || busy) {
      return;
    }
    const timer = setTimeout(
      () => {
        void execute({ kind: LessonCommand.READ, id: selected.id });
      },
      error ? 6000 : 2000,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [selected, busy, error, execute]);
  useEffect(() => {
    if (
      selected ||
      busy ||
      !lessons.some(
        (lesson) =>
          lesson.status === LessonVideoStatus.QUEUED || lesson.status === LessonVideoStatus.RUNNING,
      )
    ) {
      return;
    }
    const timer = setTimeout(() => {
      void execute({ kind: LessonCommand.LIST });
    }, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [selected, busy, lessons, execute]);
  return {
    options,
    lessons,
    selected,
    busy,
    error,
    execute,
    select: (lesson) => {
      epoch.current += 1;
      setBusy(false);
      setError(null);
      setSelected(lesson);
    },
  };
}
