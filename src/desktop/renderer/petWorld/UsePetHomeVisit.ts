import { useCallback, useEffect, useRef, useState } from 'react';
import { PetWorldCommandKind, PetWorldTiming, type PetSharedHome } from '#contracts/PetWorld.js';

export interface PetHomeVisitView {
  home: PetSharedHome | null;
  isOpen: boolean;
  isLoading: boolean;
  isUnavailable: boolean;
  visitHome: (studentId: string) => Promise<void>;
  closeHome: () => void;
}

/** Visits always read the class-scoped public projection and recheck access while open. */
export function usePetHomeVisit(userId: string, classId: string): PetHomeVisitView {
  const [home, setHome] = useState<PetSharedHome | null>(null);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [isUnavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  const visitVersion = useRef(0);
  const activeVisit = useRef<{ generation: number; version: number } | null>(null);

  useEffect(() => {
    generation.current += 1;
    activeVisit.current = null;
    setHome(null);
    setStudentId(null);
    setLoading(false);
    setUnavailable(false);
    return () => {
      generation.current += 1;
    };
  }, [userId, classId]);

  const visitHome = useCallback(
    async (nextStudentId: string): Promise<void> => {
      const currentGeneration = generation.current;
      const currentVisit = ++visitVersion.current;
      const visitRequest = { generation: currentGeneration, version: currentVisit };
      activeVisit.current = visitRequest;
      setStudentId(nextStudentId);
      setHome(null);
      setLoading(true);
      setUnavailable(false);
      try {
        const reply = await window.tro.executePetWorld?.({
          kind: PetWorldCommandKind.VISIT_HOME,
          classId,
          studentId: nextStudentId,
        });
        if (currentGeneration !== generation.current || currentVisit !== visitVersion.current) {
          return;
        }
        if (reply?.kind === 'home') {
          setHome(reply.home);
        } else {
          setUnavailable(true);
        }
      } catch {
        if (currentGeneration === generation.current && currentVisit === visitVersion.current) {
          setUnavailable(true);
        }
      } finally {
        if (activeVisit.current === visitRequest) {
          activeVisit.current = null;
        }
        if (currentGeneration === generation.current && currentVisit === visitVersion.current) {
          setLoading(false);
        }
      }
    },
    [classId],
  );

  useEffect(() => {
    if (!studentId) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!activeVisit.current) {
        void visitHome(studentId);
      }
    }, PetWorldTiming.REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [studentId, visitHome]);

  const closeHome = useCallback((): void => {
    visitVersion.current += 1;
    activeVisit.current = null;
    setStudentId(null);
    setHome(null);
    setLoading(false);
    setUnavailable(false);
  }, []);

  return { home, isOpen: studentId !== null, isLoading, isUnavailable, visitHome, closeHome };
}
