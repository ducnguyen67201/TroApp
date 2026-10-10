import {
  CaptionPlacement,
  LearnerCheckpointState,
  LearnerProjectionSchema,
  LessonPhase,
  LessonTemplateKind,
  TraceStateView,
  type Checkpoint,
  type LearnerPresentation,
  type LearnerProjection,
  type LessonInput,
  type LessonPlan,
  type NarrationBeat,
  type PlaybackCue,
  type RenderAdjustments,
  type RenderManifest,
  type Scene,
  type SceneAdjustment,
  type TraceEvent,
  type VisibleTraceState,
  type VisualCue,
} from '#contracts/GuidedLessons.js';

export interface ProjectionRecord {
  input: LessonInput;
  plan: LessonPlan | null;
  manifest: RenderManifest | null;
  adjustments: RenderAdjustments | null;
  revisionId: string;
  contentHash: string | null;
  releaseId: string | null;
}

export interface ProjectionProgress {
  version: number;
  sceneId: string;
  revealed: string[];
  attempted: string[];
  independent: string[];
  hinted: string[];
  frame: number;
  hintIds?: string[];
  reflection?: string;
}

export interface BuildLessonProjectionInput {
  record: ProjectionRecord;
  progress: ProjectionProgress;
  hashValue: (value: unknown) => string;
  sceneId?: string;
  teacherPreview?: boolean;
  /** Only trusted rendering code may choose an evidence phase; learner commands never carry this field. */
  phase?: LessonPhase;
}

function requireValue<Value>(value: Value | null | undefined, message: string): Value {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function selectPhase(
  scene: Scene,
  checkpoint: Checkpoint | undefined,
  input: BuildLessonProjectionInput,
  isLastScene: boolean,
): LessonPhase {
  const isRevealed =
    checkpoint !== undefined && input.progress.revealed.includes(checkpoint.checkpointId);
  if (input.phase !== undefined) {
    if (checkpoint && !input.teacherPreview && !isRevealed && input.phase !== checkpoint.phase) {
      throw new Error('The checkpoint is still pending.');
    }
    if (checkpoint && input.phase === LessonPhase.WATCH) {
      throw new Error('A checkpoint cannot use the watch phase.');
    }
    if (!checkpoint && input.phase !== LessonPhase.WATCH && input.phase !== LessonPhase.REFLECT) {
      throw new Error('The requested phase requires a checkpoint.');
    }
    return input.phase;
  }
  if (scene.kind !== LessonTemplateKind.CHECKPOINT || !checkpoint) {
    return LessonPhase.WATCH;
  }
  if (isRevealed || input.teacherPreview) {
    return isLastScene && input.progress.reflection?.trim()
      ? LessonPhase.REFLECT
      : LessonPhase.WORKED;
  }
  return checkpoint.phase;
}

function readPresentation(
  scene: Scene,
  checkpoint: Checkpoint | undefined,
  input: LessonInput,
  plan: LessonPlan,
): LearnerPresentation {
  const base = { templateVersion: scene.templateVersion, layoutVariant: scene.layoutVariant };
  if (scene.kind === LessonTemplateKind.CODE_TRACE) {
    const codeBlock = requireValue(
      input.codeBlocks.find((block) => block.codeBlockId === scene.params.codeBlockId),
      'Scene code is absent.',
    );
    return {
      ...base,
      kind: LessonTemplateKind.CODE_TRACE,
      codeBlock,
      focusVariable: scene.params.focusVariable,
    };
  }
  if (scene.kind === LessonTemplateKind.ANNOTATED_SOURCE) {
    return {
      ...base,
      kind: LessonTemplateKind.ANNOTATED_SOURCE,
      figure: {
        assetId: scene.params.assetId,
        callouts: scene.params.callouts.map(({ calloutId, label, x, y }) => ({
          calloutId,
          label,
          x,
          y,
        })),
      },
    };
  }
  if (scene.params.traceId !== null) {
    const trace = requireValue(
      input.traces.find((candidate) => candidate.traceId === scene.params.traceId),
      'Checkpoint trace is absent.',
    );
    const codeBlock = requireValue(
      input.codeBlocks.find((block) => block.codeBlockId === trace.codeBlockId),
      'Checkpoint code is absent.',
    );
    const focusVariable =
      checkpoint?.answerRef.kind === 'traceValue' ? checkpoint.answerRef.variable : null;
    return { ...base, kind: LessonTemplateKind.CHECKPOINT, codeBlock, focusVariable, figure: null };
  }
  const earlierFigure = plan.scenes
    .slice(0, plan.scenes.indexOf(scene))
    .reverse()
    .find((candidate) => candidate.kind === LessonTemplateKind.ANNOTATED_SOURCE);
  const figure =
    earlierFigure?.kind === LessonTemplateKind.ANNOTATED_SOURCE
      ? {
          assetId: earlierFigure.params.assetId,
          callouts: earlierFigure.params.callouts.map(({ calloutId, label, x, y }) => ({
            calloutId,
            label,
            x,
            y,
          })),
        }
      : null;
  return {
    ...base,
    kind: LessonTemplateKind.CHECKPOINT,
    codeBlock: null,
    focusVariable: null,
    figure,
  };
}

function projectState(
  event: TraceEvent,
  stateView: VisibleTraceState['stateView'],
): VisibleTraceState {
  const values = stateView === TraceStateView.BEFORE ? event.before : event.after;
  return {
    eventId: event.eventId,
    lineId: event.lineId,
    operation: event.operation,
    stateView,
    values: values.map((binding) => ({
      name: binding.name,
      value: Array.isArray(binding.value) ? [...binding.value] : binding.value,
    })),
    output: stateView === TraceStateView.AFTER ? event.output : null,
  };
}

function buildTimedVisualCues(
  eventId: string,
  cue: PlaybackCue,
  adjustment: SceneAdjustment,
): VisualCue[] {
  const stateView = cue.stateView;
  if (stateView === null) {
    return [];
  }
  const updateDelayMs =
    adjustment.beatAdjustments.find((candidate) => candidate.beatId === cue.beatId)
      ?.updateDelayMs ?? 0;
  const delayFrames =
    stateView === TraceStateView.AFTER
      ? Math.min(Math.ceil((updateDelayMs * 30) / 1000), cue.endFrame - cue.startFrame - 1)
      : 0;
  return [
    ...(delayFrames > 0
      ? [
          {
            eventId,
            stateView: TraceStateView.BEFORE,
            startFrame: cue.startFrame,
            endFrame: cue.startFrame + delayFrames,
          },
        ]
      : []),
    { eventId, stateView, startFrame: cue.startFrame + delayFrames, endFrame: cue.endFrame },
  ];
}

function readPlaybackCues(
  manifest: RenderManifest,
  scene: Scene,
  phase: LessonPhase,
  beats: NarrationBeat[],
  isPending: boolean,
): PlaybackCue[] {
  const cues = manifest.cues.filter(
    (cue) =>
      cue.sceneId === scene.sceneId &&
      cue.phase === phase &&
      beats.some((beat) => beat.beatId === cue.beatId),
  );
  if (beats.some((beat) => cues.filter((cue) => cue.beatId === beat.beatId).length !== 1)) {
    throw new Error('An approved beat does not have exactly one playback cue.');
  }
  const firstFrame = Math.min(...cues.map((cue) => cue.startFrame));
  return cues.flatMap((cue) => {
    const beat = beats.find((candidate) => candidate.beatId === cue.beatId);
    if (!beat) {
      return [];
    }
    if (
      cue.traceEventId !== beat.traceEventId ||
      cue.stateView !== beat.stateView ||
      (isPending && cue.stateView === TraceStateView.AFTER)
    ) {
      throw new Error('A playback cue changes approved trace visibility.');
    }
    if (
      cue.endFrame <= cue.startFrame ||
      !manifest.speechArtifacts.some(
        (artifact) =>
          artifact.artifactId === cue.audioArtifactId &&
          artifact.beatId === cue.beatId &&
          artifact.contentHash === manifest.contentHash,
      )
    ) {
      throw new Error('A playback cue has no matching speech artifact or positive duration.');
    }
    return [
      {
        cueId: cue.cueId,
        beatId: cue.beatId,
        artifactId: cue.audioArtifactId,
        startFrame: cue.startFrame - firstFrame,
        endFrame: cue.endFrame - firstFrame,
        text: beat.text,
        traceEventId: cue.traceEventId,
        stateView: cue.stateView,
      },
    ];
  });
}

function readVisibleStates(
  scene: Scene,
  phase: LessonPhase,
  input: LessonInput,
  cues: PlaybackCue[],
  adjustment: SceneAdjustment,
): { states: VisibleTraceState[]; visualCues: VisualCue[] } {
  const phaseEnd = Math.max(30, ...cues.map((cue) => cue.endFrame));
  if (scene.kind === LessonTemplateKind.ANNOTATED_SOURCE) {
    return { states: [], visualCues: [] };
  }
  const traceId = scene.params.traceId;
  const trace =
    traceId === null ? undefined : input.traces.find((candidate) => candidate.traceId === traceId);
  if (!trace) {
    return { states: [], visualCues: [] };
  }
  if (scene.kind === LessonTemplateKind.CHECKPOINT) {
    const event = requireValue(
      trace.events.find((candidate) => candidate.eventId === scene.params.holdEventId),
      'The checkpoint hold event is absent.',
    );
    if (phase === LessonPhase.PREDICT || phase === LessonPhase.TRY) {
      return {
        states: [projectState(event, TraceStateView.BEFORE)],
        visualCues: [
          {
            eventId: event.eventId,
            stateView: TraceStateView.BEFORE,
            startFrame: 0,
            endFrame: phaseEnd,
          },
        ],
      };
    }
    const states = [
      projectState(event, TraceStateView.BEFORE),
      projectState(event, TraceStateView.AFTER),
    ];
    const visualCues = cues
      .filter((cue) => cue.traceEventId === event.eventId && cue.stateView !== null)
      .flatMap((cue) => buildTimedVisualCues(event.eventId, cue, adjustment));
    if (visualCues.length === 0) {
      visualCues.push({
        eventId: event.eventId,
        stateView: TraceStateView.AFTER,
        startFrame: 0,
        endFrame: phaseEnd,
      });
    }
    return { states, visualCues };
  }
  if (phase === LessonPhase.REFLECT) {
    const event = requireValue(
      trace.events.find((candidate) => candidate.eventId === scene.params.traceEventIds.at(-1)),
      'The reflection state is absent.',
    );
    return {
      states: [projectState(event, TraceStateView.AFTER)],
      visualCues: [
        {
          eventId: event.eventId,
          stateView: TraceStateView.AFTER,
          startFrame: 0,
          endFrame: phaseEnd,
        },
      ],
    };
  }
  const states: VisibleTraceState[] = [];
  const visualCues: VisualCue[] = [];
  for (const cue of cues) {
    if (
      cue.traceEventId === null ||
      cue.stateView === null ||
      !scene.params.traceEventIds.includes(cue.traceEventId)
    ) {
      continue;
    }
    const event = requireValue(
      trace.events.find((candidate) => candidate.eventId === cue.traceEventId),
      'A visual cue references an absent event.',
    );
    if (
      !states.some((state) => state.eventId === event.eventId && state.stateView === cue.stateView)
    ) {
      states.push(projectState(event, cue.stateView));
    }
    const timedCues = buildTimedVisualCues(event.eventId, cue, adjustment);
    if (
      timedCues.some((item) => item.stateView === TraceStateView.BEFORE) &&
      !states.some(
        (state) => state.eventId === event.eventId && state.stateView === TraceStateView.BEFORE,
      )
    ) {
      states.push(projectState(event, TraceStateView.BEFORE));
    }
    visualCues.push(...timedCues);
  }
  const firstCue = visualCues[0];
  if (firstCue && firstCue.startFrame > 0) {
    const event = requireValue(
      trace.events.find((candidate) => candidate.eventId === firstCue.eventId),
      'The initial visual state is absent.',
    );
    if (
      !states.some(
        (state) => state.eventId === event.eventId && state.stateView === TraceStateView.BEFORE,
      )
    ) {
      states.unshift(projectState(event, TraceStateView.BEFORE));
    }
    visualCues.unshift({
      eventId: event.eventId,
      stateView: TraceStateView.BEFORE,
      startFrame: 0,
      endFrame: firstCue.startFrame,
    });
  }
  if (states.length === 0) {
    const event = requireValue(
      trace.events.find((candidate) => candidate.eventId === scene.params.traceEventIds[0]),
      'The scene has no visible trace state.',
    );
    states.push(projectState(event, TraceStateView.BEFORE));
    visualCues.push({
      eventId: event.eventId,
      stateView: TraceStateView.BEFORE,
      startFrame: 0,
      endFrame: phaseEnd,
    });
  }
  for (let index = 0; index < visualCues.length; index += 1) {
    const cue = visualCues[index];
    if (cue) {
      cue.endFrame = visualCues[index + 1]?.startFrame ?? phaseEnd;
    }
  }
  return { states, visualCues };
}

/** Build the only learner-safe presentation. Server authorization precedes this pure function; scene ordering and answer gates are enforced again here. */
export function buildLessonProjection(input: BuildLessonProjectionInput): LearnerProjection {
  const { record, progress } = input;
  const plan = requireValue(record.plan, 'No approved lesson plan is available.');
  const manifest = requireValue(record.manifest, 'No reviewed render manifest is available.');
  const contentHash = requireValue(record.contentHash, 'No content identity is available.');
  if (
    manifest.contentHash !== contentHash ||
    manifest.revisionId !== record.revisionId ||
    manifest.inputPacketHash !== record.input.sourcePacketHash
  ) {
    throw new Error('The lesson render does not match the pinned revision.');
  }
  const scene = requireValue(
    plan.scenes.find((candidate) => candidate.sceneId === (input.sceneId ?? progress.sceneId)),
    'The requested scene is absent.',
  );
  const sceneIndex = plan.scenes.indexOf(scene);
  if (!input.teacherPreview) {
    const blockedEarlierScene = plan.scenes
      .slice(0, sceneIndex)
      .some(
        (candidate) =>
          candidate.kind === LessonTemplateKind.CHECKPOINT &&
          !progress.revealed.includes(candidate.params.checkpointId),
      );
    if (blockedEarlierScene) {
      throw new Error('A previous checkpoint is still pending.');
    }
    requireValue(record.releaseId, 'A learner requires an available release.');
  }
  const checkpoint = plan.checkpoints.find((candidate) => candidate.sceneId === scene.sceneId);
  const phase = selectPhase(scene, checkpoint, input, sceneIndex === plan.scenes.length - 1);
  const isPending = phase === LessonPhase.PREDICT || phase === LessonPhase.TRY;
  const beats =
    phase === LessonPhase.REFLECT
      ? []
      : phase === LessonPhase.WORKED
        ? (checkpoint?.workedExplanation ?? [])
        : scene.narration;
  const narrationCues = readPlaybackCues(manifest, scene, phase, beats, isPending);
  const presentation = readPresentation(scene, checkpoint, record.input, plan);
  const sceneAdjustment = record.adjustments?.scenes.find(
    (candidate) => candidate.sceneId === scene.sceneId,
  ) ?? {
    sceneId: scene.sceneId,
    layoutVariant: scene.layoutVariant,
    captionPlacement: CaptionPlacement.RESERVED_BOTTOM,
    beatAdjustments: [],
  };
  if (record.adjustments && record.adjustments.contentHash !== contentHash) {
    throw new Error('Render adjustments do not match the approved content.');
  }
  if (
    manifest.adjustmentsHash !== (record.adjustments ? input.hashValue(record.adjustments) : null)
  ) {
    throw new Error('The render does not match its approved adjustments.');
  }
  const qualifiedTemplate = record.input.templates.find(
    (template) =>
      template.templateId === scene.kind && template.templateVersion === scene.templateVersion,
  );
  if (!qualifiedTemplate?.supportedLayoutVariants.includes(sceneAdjustment.layoutVariant)) {
    throw new Error('The selected render layout is not qualified.');
  }
  presentation.layoutVariant = sceneAdjustment.layoutVariant;
  const { states, visualCues } = readVisibleStates(
    scene,
    phase,
    record.input,
    narrationCues,
    sceneAdjustment,
  );
  const figureId =
    presentation.kind === LessonTemplateKind.CODE_TRACE ? null : presentation.figure?.assetId;
  const video = manifest.evidence.filter(
    (item) => item.kind === 'clip' && item.sceneId === scene.sceneId && item.phase === phase,
  );
  if (video.length > 1) {
    throw new Error('A lesson phase must have one exact approved video.');
  }
  const videoArtifactId = video[0]?.artifactId;
  const allowedArtifactIds = [
    ...new Set([
      ...narrationCues.map((cue) => cue.artifactId),
      ...(figureId ? [figureId] : []),
      ...(videoArtifactId ? [videoArtifactId] : []),
    ]),
  ];
  const checkpointState =
    checkpoint && progress.independent.includes(checkpoint.checkpointId)
      ? LearnerCheckpointState.INDEPENDENT
      : checkpoint &&
          (progress.revealed.includes(checkpoint.checkpointId) ||
            (input.teacherPreview && !isPending))
        ? LearnerCheckpointState.ASSISTED
        : checkpoint && progress.attempted.includes(checkpoint.checkpointId)
          ? LearnerCheckpointState.ATTEMPTED
          : LearnerCheckpointState.PENDING;
  return LearnerProjectionSchema.parse({
    releaseId: record.releaseId ?? `preview-${record.revisionId.slice(0, 92)}`,
    revisionId: record.revisionId,
    contentHash,
    renderManifestHash: input.hashValue(manifest),
    progressVersion: progress.version,
    frame: Math.max(
      0,
      Math.min(
        progress.frame,
        Math.max(
          30,
          ...narrationCues.map((cue) => cue.endFrame),
          ...visualCues.map((cue) => cue.endFrame),
        ) - 1,
      ),
    ),
    sceneId: scene.sceneId,
    sceneTitle: scene.title,
    presentation,
    compositionBundleHash: manifest.compositionBundleHash,
    fontBundleHash: manifest.fontBundleHash,
    sceneAdjustment,
    visualCues,
    phase,
    visibleTraceStates: states,
    narrationCues,
    ...(videoArtifactId ? { videoArtifactId } : {}),
    allowedArtifactIds,
    checkpoint: checkpoint
      ? {
          checkpointId: checkpoint.checkpointId,
          question: checkpoint.question,
          kind: checkpoint.kind,
          options: checkpoint.options,
          state: checkpointState,
          availableHintCount: Math.max(
            0,
            checkpoint.hints.filter((hint) => !progress.hintIds?.includes(hint.hintId)).length,
          ),
        }
      : null,
  });
}
