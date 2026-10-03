import type { TeachingAction } from '#contracts/TeachingStep.js';
import type { TeachingInteraction } from '#contracts/StudentActivity.js';
import type { DesktopObservationRegion } from '#contracts/DesktopObservation.js';

interface PresentationGeometry {
  steps: Record<string, unknown>[];
  targets: DesktopObservationRegion[];
  interaction: TeachingInteraction | null;
}

function center(bounds: DesktopObservationRegion) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function selection(bounds: DesktopObservationRegion): Record<string, unknown> {
  return {
    kind: 'selection',
    from: { x: bounds.x, y: bounds.y },
    to: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    duration_ms: 400,
    hold_ms: 700,
  };
}

/** The same typed action supplies the drawing and physical input matcher. */
export function createTeachingActionPresentation(action: TeachingAction): PresentationGeometry {
  switch (action.kind) {
    case 'click':
      return {
        steps: [selection(action.target.bounds)],
        targets: [action.target.bounds],
        interaction: { kind: 'click', target: action.target.bounds },
      };
    case 'drag':
      return {
        steps: [
          selection(action.source.bounds),
          {
            kind: 'drag',
            from: center(action.source.bounds),
            to: center(action.destination.bounds),
            duration_ms: 700,
            hold_ms: 700,
          },
          selection(action.destination.bounds),
        ],
        targets: [action.source.bounds, action.destination.bounds],
        interaction: {
          kind: 'drag',
          source: action.source.bounds,
          destination: action.destination.bounds,
        },
      };
    case 'scroll':
      return {
        steps: [selection(action.viewport.bounds)],
        targets: [action.viewport.bounds],
        interaction: { kind: 'scroll' },
      };
    case 'type':
      return {
        steps: action.focused ? [] : [selection(action.target.bounds)],
        targets: action.focused ? [] : [action.target.bounds],
        interaction: { kind: 'type' },
      };
    case 'highlight':
      return {
        steps: [selection(action.target.bounds)],
        targets: [action.target.bounds],
        interaction: null,
      };
    case 'keyboard':
      return { steps: [], targets: [], interaction: { kind: 'keyboard' } };
    case 'wait':
      return { steps: [], targets: [], interaction: null };
  }
}
