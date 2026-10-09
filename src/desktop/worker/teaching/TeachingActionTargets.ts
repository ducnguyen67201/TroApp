import { TeachingActionKind, type TeachingAction } from '#contracts/TeachingStep.js';
import type { TeachingInteraction } from '#contracts/StudentActivity.js';
import type { DesktopObservationRegion } from '#contracts/DesktopObservation.js';

interface TeachingActionTargets {
  targets: DesktopObservationRegion[];
  interaction: TeachingInteraction | null;
}

/** Action bounds own student matching; decorative drawing paths never change it. */
export function createTeachingActionTargets(action: TeachingAction): TeachingActionTargets {
  switch (action.kind) {
    case TeachingActionKind.CLICK:
      return {
        targets: [action.target.bounds],
        interaction: { kind: 'click', target: action.target.bounds },
      };
    case TeachingActionKind.DRAG:
      return {
        targets: [action.source.bounds, action.destination.bounds],
        interaction: {
          kind: 'drag',
          source: action.source.bounds,
          destination: action.destination.bounds,
        },
      };
    case TeachingActionKind.SCROLL:
      return { targets: [action.viewport.bounds], interaction: { kind: 'scroll' } };
    case TeachingActionKind.TYPE:
      return {
        targets: action.focused ? [] : [action.target.bounds],
        interaction: { kind: 'type' },
      };
    case TeachingActionKind.HIGHLIGHT:
      return { targets: [action.target.bounds], interaction: null };
    case TeachingActionKind.KEYBOARD:
      return { targets: [], interaction: { kind: 'keyboard' } };
    case TeachingActionKind.WAIT:
      return { targets: [], interaction: null };
  }
}
