import { useEffect, useState } from 'react';
import { ClassroomPhase, ClassroomStatus, type TeachingContext } from '#contracts/Classroom.js';
import type { PracticeShortcutEvent } from '#contracts/PracticeShortcut.js';
import { ClassView, type ClassView as View } from '../navigation/DesktopRoute.js';

/** Receives navigation intent only; evidence transfer stays behind explicit review buttons. */
export function usePracticeShortcut(
  context: TeachingContext | null,
  openClass: (classId: string, view: View) => void,
): PracticeShortcutEvent | undefined {
  const [practiceReview, setPracticeReview] = useState<PracticeShortcutEvent | undefined>();
  useEffect(() => {
    let disposed = false;
    let globalAvailable = false;
    let availabilityKnown = !window.tro.readPracticeShortcutAvailable;
    const eligible =
      context?.meeting.status === ClassroomStatus.LIVE &&
      context.meeting.phase === ClassroomPhase.PRACTICE &&
      Date.parse(context.participation.leaseUntil) > Date.now() &&
      context.activity.practiceCheckpoints?.some((item) => item.approved);
    if (!context || !eligible) {
      setPracticeReview(undefined);
      return;
    }
    void window.tro
      .readPracticeShortcutAvailable?.()
      .then((available) => {
        if (!disposed) {
          globalAvailable = available;
          availabilityKnown = true;
        }
      })
      .catch(() => {
        availabilityKnown = true;
      });
    const openReview = (event: PracticeShortcutEvent): void => {
      if (
        disposed ||
        Date.parse(context.participation.leaseUntil) <= Date.now() ||
        event.participationId !== context.participation.id ||
        event.activityId !== context.activity.id ||
        event.attemptId !== context.attempt.id ||
        event.contextVersion !== context.meeting.contextVersion ||
        event.classId !== context.meeting.classId
      ) {
        return;
      }
      setPracticeReview(event);
      openClass(event.classId, ClassView.ACTIVITIES);
    };
    const unsubscribe = window.tro.subscribePracticeShortcut?.(openReview);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !availabilityKnown ||
        globalAvailable ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        !event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key !== 'Enter'
      ) {
        return;
      }
      event.preventDefault();
      openReview({
        requestId: crypto.randomUUID(),
        classId: context.meeting.classId,
        participationId: context.participation.id,
        activityId: context.activity.id,
        attemptId: context.attempt.id,
        contextVersion: context.meeting.contextVersion,
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [context, openClass]);

  return practiceReview;
}
