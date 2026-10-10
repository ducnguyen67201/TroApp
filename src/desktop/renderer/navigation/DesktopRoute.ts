import { z } from 'zod';

export const DesktopPage = {
  WORKSPACE: 'workspace',
  CLASSROOM: 'classroom',
  INSIGHTS: 'insights',
  GUIDED_LESSONS: 'guided-lessons',
} as const;

export const ClassView = {
  OVERVIEW: 'classes',
  ACTIVITIES: 'activities',
  MATERIALS: 'lessons',
  SETTINGS: 'settings',
} as const;

export type ClassView = (typeof ClassView)[keyof typeof ClassView];

export interface DesktopRoute {
  page: (typeof DesktopPage)[keyof typeof DesktopPage];
  classId: string | null;
  classView: ClassView;
}

/** Hash routes work with Electron's file entry point. A route grants no class access. */
export function parseDesktopRoute(hash: string): DesktopRoute {
  const segments = hash.replace(/^#/, '').split('/');
  const classId = z.uuid().safeParse(segments[2]);
  const classView =
    segments[3] === 'activities'
      ? ClassView.ACTIVITIES
      : segments[3] === 'materials'
        ? ClassView.MATERIALS
        : segments[3] === 'settings'
          ? ClassView.SETTINGS
          : ClassView.OVERVIEW;
  if (segments[1] === 'insights') {
    return {
      page: DesktopPage.INSIGHTS,
      classId: classId.success ? classId.data : null,
      classView: ClassView.OVERVIEW,
    };
  }
  if (segments[1] === 'guided-lessons') {
    return {
      page: DesktopPage.GUIDED_LESSONS,
      classId: classId.success ? classId.data : null,
      classView: ClassView.OVERVIEW,
    };
  }
  if (segments[1] === 'classroom') {
    return {
      page: DesktopPage.CLASSROOM,
      classId: classId.success ? classId.data : null,
      classView,
    };
  }
  return { page: DesktopPage.WORKSPACE, classId: null, classView: ClassView.OVERVIEW };
}

export function formatClassRoute(classId: string, view: ClassView): string {
  const suffix =
    view === ClassView.ACTIVITIES
      ? '/activities'
      : view === ClassView.MATERIALS
        ? '/materials'
        : view === ClassView.SETTINGS
          ? '/settings'
          : '';
  return `#/classroom/${classId}${suffix}`;
}
