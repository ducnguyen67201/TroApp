import type { ReactElement } from 'react';
import type { ClassroomTranslate } from './ClassroomLabels.js';

interface ClassSessionBadgeProps {
  live: boolean;
  t: ClassroomTranslate;
}

/** Reports session availability; it does not imply that this student has joined. */
export function ClassSessionBadge({ live, t }: ClassSessionBadgeProps): ReactElement {
  return (
    <span className="classroom-session-badge" data-live={live}>
      <span className="classroom-session-dot" aria-hidden="true" />
      {live ? t('Live now', 'Đang diễn ra') : t('Waiting to start', 'Chờ bắt đầu')}
    </span>
  );
}
