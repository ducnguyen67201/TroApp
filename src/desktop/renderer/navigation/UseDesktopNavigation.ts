import { useCallback, useEffect, useState } from 'react';
import {
  formatClassRoute,
  parseDesktopRoute,
  type ClassView,
  type DesktopRoute,
} from './DesktopRoute.js';

export interface DesktopNavigation {
  route: DesktopRoute;
  openWorkspace: () => void;
  openClassroom: () => void;
  openClass: (classId: string, view: ClassView) => void;
}

/** Native browser history supplies Back/Forward without loading another Electron document. */
export function useDesktopNavigation(): DesktopNavigation {
  const [route, setRoute] = useState(() => parseDesktopRoute(window.location.hash));
  useEffect(() => {
    const readRoute = (): void => {
      setRoute(parseDesktopRoute(window.location.hash));
    };
    window.addEventListener('hashchange', readRoute);
    return () => {
      window.removeEventListener('hashchange', readRoute);
    };
  }, []);
  const navigate = useCallback((hash: string): void => {
    window.location.hash = hash;
    setRoute(parseDesktopRoute(hash));
  }, []);
  return {
    route,
    openWorkspace: useCallback(() => {
      navigate('#/workspace');
    }, [navigate]),
    openClassroom: useCallback(() => {
      navigate('#/classroom');
    }, [navigate]),
    openClass: useCallback(
      (classId: string, view: ClassView) => {
        navigate(formatClassRoute(classId, view));
      },
      [navigate],
    ),
  };
}
