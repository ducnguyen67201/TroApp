import { useCallback, useEffect, useRef, useState } from 'react';
import { PetWorldCommandKind, type PetSharedHome } from '#contracts/PetWorld.js';

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

  useEffect(() => {
    generation.current += 1;
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
      void visitHome(studentId);
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [studentId, visitHome]);

  const closeHome = useCallback((): void => {
    visitVersion.current += 1;
    setStudentId(null);
    setHome(null);
    setLoading(false);
    setUnavailable(false);
  }, []);

  return { home, isOpen: studentId !== null, isLoading, isUnavailable, visitHome, closeHome };
}
