import { useCallback, useEffect, useRef, useState } from 'react';
import type { PetCommand, PetSnapshot } from '#contracts/Pet.js';

export interface PetView {
  snapshot: PetSnapshot | null;
  isSaving: boolean;
  hasError: boolean;
  isAvailable: boolean;
  sendCommand(command: PetCommand): Promise<void>;
}

/** Subscriptions and replies are fenced to the current signed-in account. */
export function usePets(accountId: string | null): PetView {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [hasError, setError] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const revision = useRef(-1);
  const isAvailable = Boolean(
    window.tro.readPets && window.tro.controlPet && window.tro.subscribePet,
  );

  const acceptSnapshot = useCallback((next: PetSnapshot): void => {
    if (next.revision >= revision.current) {
      revision.current = next.revision;
      setSnapshot(next);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    const currentGeneration = generation.current;
    revision.current = -1;
    pending.current = false;
    setSnapshot(null);
    setSaving(false);
    setError(false);
    if (!accountId || !window.tro.readPets || !window.tro.subscribePet) {
      return;
    }
    const unsubscribe = window.tro.subscribePet((next) => {
      if (generation.current === currentGeneration) {
        acceptSnapshot(next);
      }
    });
    void window.tro
      .readPets()
      .then((reply) => {
        if (generation.current !== currentGeneration) {
          return;
        }
        if (reply.kind === 'ok') {
          acceptSnapshot(reply.snapshot);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (generation.current === currentGeneration) {
          setError(true);
        }
      });
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [accountId, acceptSnapshot]);

  const sendCommand = useCallback(
    async (command: PetCommand): Promise<void> => {
      if (!accountId || pending.current || !window.tro.controlPet) {
        return;
      }
      const currentGeneration = generation.current;
      pending.current = true;
      setSaving(true);
      setError(false);
      try {
        const reply = await window.tro.controlPet(command);
        if (generation.current === currentGeneration) {
          if (reply.kind === 'ok') {
            acceptSnapshot(reply.snapshot);
          } else {
            setError(true);
          }
        }
      } catch {
        if (generation.current === currentGeneration) {
          setError(true);
        }
      } finally {
        if (generation.current === currentGeneration) {
          pending.current = false;
          setSaving(false);
        }
      }
    },
    [accountId, acceptSnapshot],
  );

  return { snapshot, isSaving, hasError, isAvailable, sendCommand };
}
