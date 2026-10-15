import type { ReactElement } from 'react';
import type { ClassroomHome } from '#contracts/Classroom.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

interface ClassOrganizationBadgeProps {
  entry: ClassroomHome['classes'][number];
  t: ClassroomTranslate;
}

/** Shows the class's recorded organization, independently of selected sidebar branding. */
export function ClassOrganizationBadge({ entry, t }: ClassOrganizationBadgeProps): ReactElement {
  const name =
    entry.organizationName ??
    (entry.organizationId ? t('Organization', 'Tổ chức') : t('Personal', 'Cá nhân'));
  return (
    <span className="classroom-organization-badge" title={name}>
      <span aria-hidden="true">✦</span>
      {name}
    </span>
  );
}
