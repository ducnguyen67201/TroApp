import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClassroomHome } from '#contracts/Classroom.js';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  PetWorldCommandKind,
  PetWorldCommandSchema,
  PetWorldFailure,
  type PetCatalog,
  type PetOwnWorld,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';

type RecognitionView = Extract<PetWorldReply, { kind: 'class-recognition' }>;
type NeighborhoodView = Extract<PetWorldReply, { kind: 'neighborhood' }>;
type HistoryView = Extract<PetWorldReply, { kind: 'history' }>;

export interface PetWorldView {
  classroom: ClassroomHome | null;
  world: PetOwnWorld | null;
  catalog: PetCatalog | null;
  recognition: RecognitionView | null;
  neighborhood: NeighborhoodView | null;
  history: HistoryView | null;
  pendingCommands: PetWorldCommand[];
  isLoading: boolean;
  isSaving: boolean;
  isAvailable: boolean;
  failure: PetWorldFailure | null;
  refresh: () => Promise<void>;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
  readOlderHistory: () => Promise<void>;
  readOlderRecognitions: () => Promise<void>;
}

interface RecognitionPeriod {
  from: string;
  to: string;
}

/** Server replies own balances. Account and selection fences discard stale asynchronous reads. */
export function usePetWorld(
  userId: string,
  classId: string | null,
  period: RecognitionPeriod,
): PetWorldView {
  const [classroom, setClassroom] = useState<ClassroomHome | null>(null);
  const [world, setWorld] = useState<PetOwnWorld | null>(null);
  const [catalog, setCatalog] = useState<PetCatalog | null>(null);
  const [recognition, setRecognition] = useState<RecognitionView | null>(null);
  const [neighborhood, setNeighborhood] = useState<NeighborhoodView | null>(null);
  const [history, setHistory] = useState<HistoryView | null>(null);
  const [pendingCommands, setPendingCommands] = useState<PetWorldCommand[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  const [failure, setFailure] = useState<PetWorldFailure | null>(null);
  const generation = useRef(0);
  const readVersion = useRef(0);
  const pending = useRef(false);
  const worldRevision = useRef({ wallet: -1, profile: -1 });
  const isAvailable = Boolean(window.tro.executePetWorld);

  const acceptWorld = useCallback((next: PetOwnWorld): void => {
    if (
      next.wallet.revision < worldRevision.current.wallet ||
      (next.profile?.revision ?? -1) < worldRevision.current.profile
    ) {
      return;
    }
    worldRevision.current = {
      wallet: next.wallet.revision,
      profile: next.profile?.revision ?? -1,
    };
    setWorld(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = window.tro.executePetWorld;
    if (!bridge) {
      setLoading(false);
      return;
    }
    const currentGeneration = generation.current;
    const currentRead = ++readVersion.current;
    const isCurrent = (): boolean =>
      currentGeneration === generation.current && currentRead === readVersion.current;
    try {
      const [classroomReply, worldReply, catalogReply, unresolved] = await Promise.all([
        window.tro.controlClassroom?.({ kind: 'home' }),
        bridge({ kind: PetWorldCommandKind.OWN_WORLD }),
        bridge({ kind: PetWorldCommandKind.CATALOG }),
        window.tro.readPetWorldPending?.() ?? Promise.resolve([]),
      ]);
      if (!isCurrent()) {
        return;
      }
      setFailure(null);
      setPendingCommands(unresolved);
      if (classroomReply?.kind === 'home') {
        setClassroom(classroomReply.home);
      } else if (classroomReply?.kind === 'failed') {
        setClassroom(null);
        setRecognition(null);
        setNeighborhood(null);
      }
      if (worldReply.kind === 'world') {
        acceptWorld(worldReply.world);
      } else if (worldReply.kind === 'failed' && worldReply.code !== PetWorldFailure.FORBIDDEN) {
        setFailure(worldReply.code);
      } else if (worldReply.kind === 'failed') {
        setWorld(null);
      }
      if (catalogReply.kind === 'catalog') {
        setCatalog(catalogReply.catalog);
      } else if (catalogReply.kind === 'failed') {
        const isTeacherWithoutWallet =
          classroomReply?.kind === 'home' &&
          classroomReply.home.role === AccountRole.TEACHER &&
          worldReply.kind === 'failed' &&
          worldReply.code === PetWorldFailure.FORBIDDEN;
        if (catalogReply.code !== PetWorldFailure.FORBIDDEN || !isTeacherWithoutWallet) {
          setFailure(catalogReply.code);
        }
      }
      if (!classId) {
        setRecognition(null);
        setNeighborhood(null);
        return;
      }
      const commands: PetWorldCommand[] = [
        { kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD, classId },
      ];
      if (classroomReply?.kind === 'home' && classroomReply.home.role === AccountRole.TEACHER) {
        commands.push({ kind: PetWorldCommandKind.CLASS_RECOGNITION, classId, ...period });
      }
      const replies = await Promise.all(commands.map((command) => bridge(command)));
      if (!isCurrent()) {
        return;
      }
      for (const [index, reply] of replies.entries()) {
        if (reply.kind === 'class-recognition') {
          setRecognition(reply);
        } else if (reply.kind === 'neighborhood') {
          setNeighborhood(reply);
        } else if (reply.kind === 'failed') {
          setFailure(reply.code);
          if (commands[index]?.kind === PetWorldCommandKind.CLASS_RECOGNITION) {
            setRecognition(null);
          } else {
            setNeighborhood(null);
          }
        }
      }
    } catch {
      if (isCurrent()) {
        setFailure(PetWorldFailure.UNAVAILABLE);
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }, [classId, period, acceptWorld]);

  useEffect(() => {
    generation.current += 1;
    worldRevision.current = { wallet: -1, profile: -1 };
    pending.current = false;
    setClassroom(null);
    setWorld(null);
    setCatalog(null);
    setRecognition(null);
    setNeighborhood(null);
    setHistory(null);
    setPendingCommands([]);
    setFailure(null);
    setLoading(true);
    setSaving(false);
    return () => {
      generation.current += 1;
    };
  }, [userId]);

  useEffect(() => {
    setRecognition(null);
    setNeighborhood(null);
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden && !pending.current) {
        void refresh();
      }
    }, 15_000);
    return () => {
      readVersion.current += 1;
      window.clearInterval(timer);
    };
  }, [userId, refresh]);

  const sendCommand = useCallback(
    async (command: PetWorldCommand): Promise<boolean> => {
      if (!window.tro.executePetWorld || pending.current) {
        return false;
      }
      const parsed = PetWorldCommandSchema.safeParse(command);
      if (!parsed.success) {
        setFailure(PetWorldFailure.INVALID);
        return false;
      }
      const currentGeneration = generation.current;
      pending.current = true;
      setSaving(true);
      setFailure(null);
      let succeeded = false;
      try {
        const reply = await window.tro.executePetWorld(parsed.data);
        if (currentGeneration !== generation.current) {
          return false;
        }
        if (reply.kind === 'failed') {
          setFailure(reply.code);
        } else {
          succeeded = true;
          setHistory(null);
        }
      } catch {
        if (currentGeneration === generation.current) {
          setFailure(PetWorldFailure.UNAVAILABLE);
        }
      } finally {
        try {
          const unresolved = await window.tro.readPetWorldPending?.();
          if (currentGeneration === generation.current && unresolved) {
            setPendingCommands(unresolved);
          }
        } catch {
          if (currentGeneration === generation.current) {
            setFailure(PetWorldFailure.UNAVAILABLE);
          }
        }
        if (currentGeneration === generation.current) {
          pending.current = false;
          setSaving(false);
        }
      }
      if (succeeded && currentGeneration === generation.current) {
        await refresh();
      }
      return succeeded;
    },
    [refresh],
  );

  const readOlderHistory = useCallback(async (): Promise<void> => {
    const currentGeneration = generation.current;
    try {
      const reply = await window.tro.executePetWorld?.({
        kind: PetWorldCommandKind.OWN_HISTORY,
        ...(history?.nextCursor ? { cursor: history.nextCursor } : {}),
      });
      if (currentGeneration === generation.current && reply?.kind === 'history') {
        if (reply.walletRevision >= worldRevision.current.wallet) {
          setHistory(reply);
        }
      } else if (currentGeneration === generation.current && reply?.kind === 'failed') {
        setFailure(reply.code);
      }
    } catch {
      if (currentGeneration === generation.current) {
        setFailure(PetWorldFailure.UNAVAILABLE);
      }
    }
  }, [history?.nextCursor]);

  const readOlderRecognitions = useCallback(async (): Promise<void> => {
    if (!classId || !recognition?.nextCursor) {
      return;
    }
    const currentGeneration = generation.current;
    const currentRead = readVersion.current;
    try {
      const reply = await window.tro.executePetWorld?.({
        kind: PetWorldCommandKind.CLASS_RECOGNITION,
        classId,
        ...period,
        cursor: recognition.nextCursor,
      });
      if (
        currentGeneration === generation.current &&
        currentRead === readVersion.current &&
        reply?.kind === 'class-recognition'
      ) {
        setRecognition(reply);
      } else if (
        currentGeneration === generation.current &&
        currentRead === readVersion.current &&
        reply?.kind === 'failed'
      ) {
        setFailure(reply.code);
        if (reply.code === PetWorldFailure.FORBIDDEN) {
          setRecognition(null);
        }
      }
    } catch {
      if (currentGeneration === generation.current) {
        setFailure(PetWorldFailure.UNAVAILABLE);
      }
    }
  }, [classId, recognition?.nextCursor, period]);

  return {
    classroom,
    world,
    catalog,
    recognition,
    neighborhood,
    history,
    pendingCommands,
    isLoading,
    isSaving,
    isAvailable,
    failure,
    refresh,
    sendCommand,
    readOlderHistory,
    readOlderRecognitions,
  };
}
