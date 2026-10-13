import { z } from 'zod';

export const DesktopPage = {
  WORKSPACE: 'workspace',
  LESSON_VIDEOS: 'lesson-videos',
  CLASSROOM: 'classroom',
  INSIGHTS: 'insights',
  PET_WORLD: 'pet-world',
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
  if (segments[1] === 'lesson-videos') {
    return {
      page: DesktopPage.LESSON_VIDEOS,
      classId: classId.success ? classId.data : null,
      classView: ClassView.OVERVIEW,
    };
  }
  if (segments[1] === 'insights') {
    return {
      page: DesktopPage.INSIGHTS,
      classId: classId.success ? classId.data : null,
      classView: ClassView.OVERVIEW,
    };
  }
  if (segments[1] === 'pet-world') {
    return {
      page: DesktopPage.PET_WORLD,
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
