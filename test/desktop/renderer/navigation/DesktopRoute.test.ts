import { describe, expect, it } from 'vitest';
import {
  ClassView,
  DesktopPage,
  formatClassRoute,
  parseDesktopRoute,
} from '../../../../src/desktop/renderer/navigation/DesktopRoute.js';

const classId = '11111111-1111-4111-8111-111111111111';

describe('desktop class routes', () => {
  it('round trips class pages with their selected view', () => {
    for (const classView of Object.values(ClassView)) {
      expect(parseDesktopRoute(formatClassRoute(classId, classView))).toEqual({
        page: DesktopPage.CLASSROOM,
        classId,
        classView,
      });
    }
  });

  it('does not treat an invalid class identifier or unknown page as a class route', () => {
    expect(parseDesktopRoute('#/classroom/not-a-class/settings').classId).toBeNull();
    expect(parseDesktopRoute('#/somewhere/else')).toEqual({
      page: DesktopPage.WORKSPACE,
      classId: null,
      classView: ClassView.OVERVIEW,
    });
  });
});
