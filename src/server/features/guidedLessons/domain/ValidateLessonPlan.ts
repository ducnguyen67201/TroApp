import {
  CheckpointKind,
  CheckpointPhase,
  LessonTemplateKind,
  ReviewCriterion,
  ReviewSeverity,
  SourcePassageKind,
  TraceOperation,
  TraceStateView,
  type Checkpoint,
  type LessonInput,
  type LessonPlan,
  type NarrationBeat,
  type ReviewIssue,
  type Scene,
  type SourceRef,
} from '#contracts/GuidedLessons.js';
import { usesLessonGlyphs } from './LessonGlyphs.js';
import { AccumulatorEngineVersion } from './CompileAccumulator.js';

interface IssueLocation {
  sceneId?: string;
  beatId?: string;
}

type AddIssue = (
  criterion: ReviewIssue['criterion'],
  observed: string,
  expected: string,
  location?: IssueLocation,
) => void;

function createIssueCollector(): { issues: ReviewIssue[]; addIssue: AddIssue } {
  const issues: ReviewIssue[] = [];
  const addIssue: AddIssue = (criterion, observed, expected, location = {}) => {
    if (issues.length >= 20) {
      return;
    }
    issues.push({
      issueId: `validation-${String(issues.length + 1)}`,
      criterion,
      severity: ReviewSeverity.BLOCKER,
      sceneId: location.sceneId ?? null,
      beatId: location.beatId ?? null,
      frameId: null,
      timeMs: null,
      evidenceIds: [],
      observed: observed.slice(0, 600),
      expected: expected.slice(0, 600),
      suggestedFix: 'Correct the referenced lesson content before approval.',
    });
  };
  return { issues, addIssue };
}

function checkUniqueIds(ids: string[], label: string, addIssue: AddIssue): void {
  if (new Set(ids).size !== ids.length) {
    addIssue(
      ReviewCriterion.CONTINUITY,
      `${label} contains duplicate identifiers.`,
      'Each owned identifier must be unique.',
    );
  }
}

function checkSourceRefs(
  input: LessonInput,
  sourceRefs: SourceRef[],
  addIssue: AddIssue,
  location: IssueLocation = {},
): void {
  for (const reference of sourceRefs) {
    const passage = input.passages.find((candidate) => candidate.passageId === reference.passageId);
    if (
      !passage ||
      reference.startOffset >= reference.endOffset ||
      reference.endOffset > passage.text.length
    ) {
      addIssue(
        ReviewCriterion.SOURCE_SUPPORT,
        'A citation does not select a nonempty range in the pinned source packet.',
        'Use an existing passage and exact character offsets.',
        location,
      );
      continue;
    }
    const relevantCorrections = input.passages.filter(
      (candidate) =>
        candidate.kind !== SourcePassageKind.SOURCE_TEXT &&
        candidate.correctsPassageIds.includes(passage.passageId),
    );
    if (
      relevantCorrections.some(
        (correction) =>
          !sourceRefs.some((candidate) => candidate.passageId === correction.passageId),
      )
    ) {
      addIssue(
        ReviewCriterion.SOURCE_SUPPORT,
        'A source citation omits its published teacher correction.',
        'Include the correction as a separate citation and resolve conflicts before approval.',
        location,
      );
    }
  }
}

/** Check authoritative input references independently of model output. Digests and approval receipts are supplied by the backend. */
export function validateLessonInput(input: LessonInput): ReviewIssue[] {
  const { issues, addIssue } = createIssueCollector();
  checkUniqueIds(
    input.passages.map((passage) => passage.passageId),
    'Source packet',
    addIssue,
  );
  checkUniqueIds(
    input.codeBlocks.map((block) => block.codeBlockId),
    'Code blocks',
    addIssue,
  );
  checkUniqueIds(
    input.traces.map((trace) => trace.traceId),
    'Traces',
    addIssue,
  );
  checkUniqueIds(
    input.traces.flatMap((trace) => trace.events.map((event) => event.eventId)),
    'Trace events',
    addIssue,
  );
  checkUniqueIds(
    input.assets.map((asset) => asset.assetId),
    'Assets',
    addIssue,
  );
  checkUniqueIds(
    input.teacherAnswerKeys.map((key) => key.answerKeyId),
    'Teacher answer keys',
    addIssue,
  );
  checkUniqueIds(
    input.templates.map((template) => template.templateId),
    'Templates',
    addIssue,
  );
  for (const passage of input.passages) {
    if (passage.kind === SourcePassageKind.SOURCE_TEXT && passage.correctsPassageIds.length !== 0) {
      addIssue(
        ReviewCriterion.SOURCE_SUPPORT,
        'Original source text claims to be a correction.',
        'Only published correction entries may identify corrected passages.',
      );
    }
    if (passage.correctsPassageIds.includes(passage.passageId)) {
      addIssue(
        ReviewCriterion.SOURCE_SUPPORT,
        'A source entry corrects itself.',
        'Preserve original and correction identities separately.',
      );
    }
  }
  for (const block of input.codeBlocks) {
    checkUniqueIds(
      block.lines.map((line) => line.lineId),
      'Code lines',
      addIssue,
    );
    checkSourceRefs(input, block.sourceRefs, addIssue);
    if (block.variantOfCodeBlockId !== null) {
      const base = input.codeBlocks.find(
        (candidate) => candidate.codeBlockId === block.variantOfCodeBlockId,
      );
      if (!base || base.variantOfCodeBlockId !== null || base.codeBlockId === block.codeBlockId) {
        addIssue(
          ReviewCriterion.TRACE_CORRECTNESS,
          'A practice variant has no approved base example.',
          'Link the separately approved practice code to its base example.',
        );
      }
    }
    if (input.traces.filter((trace) => trace.codeBlockId === block.codeBlockId).length !== 1) {
      addIssue(
        ReviewCriterion.TRACE_CORRECTNESS,
        'An approved code block does not have exactly one canonical trace.',
        'Compile each approved code block once with the bounded compiler.',
      );
    }
  }
  for (const trace of input.traces) {
    const block = input.codeBlocks.find((candidate) => candidate.codeBlockId === trace.codeBlockId);
    if (!block || trace.engineVersion !== AccumulatorEngineVersion) {
      addIssue(
        ReviewCriterion.TRACE_CORRECTNESS,
        'A trace has no supported approved code block.',
        'Use the supported compiler and the matching approved code.',
      );
      continue;
    }
    for (let index = 0; index < trace.events.length; index += 1) {
      const event = trace.events[index];
      const previous = trace.events[index - 1];
      if (!event) {
        continue;
      }
      if (
        !block.lines.some((line) => line.lineId === event.lineId) ||
        (previous && JSON.stringify(previous.after) !== JSON.stringify(event.before))
      ) {
        addIssue(
          ReviewCriterion.TRACE_CORRECTNESS,
          'Trace lines or consecutive states do not match the approved program.',
          'Use the unmodified compiler trace.',
        );
      }
      checkUniqueIds(
        event.before.map((binding) => binding.name),
        'Before-state variables',
        addIssue,
      );
      checkUniqueIds(
        event.after.map((binding) => binding.name),
        'After-state variables',
        addIssue,
      );
      if ((event.operation === TraceOperation.OUTPUT) !== (event.output !== null)) {
        addIssue(
          ReviewCriterion.TRACE_CORRECTNESS,
          'Output metadata does not match the operation.',
          'Only the output event may carry printed output.',
        );
      }
    }
  }
  for (const asset of input.assets) {
    checkSourceRefs(input, asset.sourceRefs, addIssue);
    checkUniqueIds(
      asset.regions.map((region) => region.regionId),
      'Figure regions',
      addIssue,
    );
    for (const region of asset.regions) {
      checkSourceRefs(input, region.sourceRefs, addIssue);
    }
  }
  for (const key of input.teacherAnswerKeys) {
    checkSourceRefs(input, key.sourceRefs, addIssue);
    checkUniqueIds(
      key.options.map((option) => option.optionId),
      'Answer key options',
      addIssue,
    );
    if (!key.options.some((option) => option.optionId === key.correctOptionId)) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'An approved answer key names an absent option.',
        'The correct option must belong to the approved key.',
      );
    }
  }
  return issues;
}

function checkNarration(
  input: LessonInput,
  beat: NarrationBeat,
  addIssue: AddIssue,
  scene: Scene,
): void {
  const location = { sceneId: scene.sceneId, beatId: beat.beatId };
  checkSourceRefs(input, beat.sourceRefs, addIssue, location);
  if ((beat.traceEventId === null) !== (beat.stateView === null)) {
    addIssue(
      ReviewCriterion.TIMELINE,
      'Narration has incomplete trace-state metadata.',
      'Reference an event and state view together, or neither.',
      location,
    );
  }
  if (
    beat.traceEventId !== null &&
    !input.traces.some((trace) => trace.events.some((event) => event.eventId === beat.traceEventId))
  ) {
    addIssue(
      ReviewCriterion.TRACE_CORRECTNESS,
      'Narration names an absent trace event.',
      'Use an event from the pinned canonical trace.',
      location,
    );
  }
}

function checkCheckpoint(
  input: LessonInput,
  plan: LessonPlan,
  checkpoint: Checkpoint,
  addIssue: AddIssue,
): void {
  const location = { sceneId: checkpoint.sceneId };
  const scene = plan.scenes.find((candidate) => candidate.sceneId === checkpoint.sceneId);
  checkSourceRefs(input, checkpoint.sourceRefs, addIssue, location);
  for (const hint of checkpoint.hints) {
    checkSourceRefs(input, hint.sourceRefs, addIssue, location);
  }
  if (
    !scene ||
    scene.kind !== LessonTemplateKind.CHECKPOINT ||
    scene.params.checkpointId !== checkpoint.checkpointId
  ) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'A checkpoint does not have one matching checkpoint scene.',
      'Link the checkpoint and scene in both directions.',
      location,
    );
    return;
  }
  for (const beat of checkpoint.workedExplanation) {
    checkNarration(input, beat, addIssue, scene);
  }
  if (checkpoint.kind === CheckpointKind.SOURCE_CHOICE) {
    const answer = checkpoint.answerRef;
    const key =
      answer.kind === 'teacherAnswer'
        ? input.teacherAnswerKeys.find((candidate) => candidate.answerKeyId === answer.answerKeyId)
        : undefined;
    if (
      !key ||
      key.question !== checkpoint.question ||
      JSON.stringify(key.options) !== JSON.stringify(checkpoint.options)
    ) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'A choice checkpoint is not an exact approved teacher question.',
        'Copy the supplied approved question and options without changing their meaning.',
        location,
      );
    }
    if (
      [...scene.narration, ...checkpoint.workedExplanation].some(
        (beat) => beat.traceEventId !== null || beat.stateView !== null,
      )
    ) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'A source-only checkpoint narrates an unrelated code state.',
        'Keep source-only narration trace metadata null.',
        location,
      );
    }
    if (scene.params.traceId !== null || scene.params.holdEventId !== null) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'A source choice checkpoint has unexpected code hold metadata.',
        'Keep source-only checkpoint trace fields null.',
        location,
      );
    }
    return;
  }
  const answer = checkpoint.answerRef;
  if (answer.kind !== 'traceValue' || checkpoint.options.length !== 0) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'A numeric checkpoint has an incompatible answer reference or choices.',
      'Use one scalar after-state value and no answer options.',
      location,
    );
    return;
  }
  const trace = input.traces.find((candidate) => candidate.traceId === answer.traceId);
  const event = trace?.events.find((candidate) => candidate.eventId === answer.eventId);
  const binding = event?.after.find((candidate) => candidate.name === answer.variable);
  const block = input.codeBlocks.find((candidate) => candidate.codeBlockId === trace?.codeBlockId);
  if (
    !trace ||
    !event ||
    !binding ||
    typeof binding.value !== 'number' ||
    !block ||
    event.operation !== TraceOperation.ADD
  ) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'A numeric checkpoint has no scalar canonical addition result.',
      'Select a valid addition event and its after-state running total.',
      location,
    );
    return;
  }
  const additionLine = block.lines.find((line) => line.lineId === event.lineId);
  const runningVariable = additionLine?.text
    .trim()
    .match(/^([A-Za-z_][A-Za-z0-9_]*) (?:=|\+=)/)?.[1];
  if (answer.variable !== runningVariable) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'The numeric answer references the input instead of the running total.',
      'Use the scalar accumulator updated by the held addition.',
      location,
    );
  }
  if (scene.params.traceId !== trace.traceId || scene.params.holdEventId !== event.eventId) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'Checkpoint hold metadata does not match its authoritative answer.',
      'Hold the same event before the update and reveal it only after an authorized action.',
      location,
    );
  }
  if ((checkpoint.phase === CheckpointPhase.TRY) !== (block.variantOfCodeBlockId !== null)) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'Checkpoint phase does not match the approved code variant.',
      'Predict uses the base example; Try uses a separately approved practice variant.',
      location,
    );
  }
  if (checkpoint.phase === CheckpointPhase.TRY) {
    const baseTrace = input.traces.find(
      (candidate) => candidate.codeBlockId === block.variantOfCodeBlockId,
    );
    if (!baseTrace || baseTrace.codeDigest === trace.codeDigest) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'The practice variant duplicates the demonstrated program.',
        'Use a separately approved input variant for independent practice.',
        location,
      );
    }
  }
  for (const beat of scene.narration) {
    if (
      beat.traceEventId !== null &&
      (beat.traceEventId !== event.eventId || beat.stateView !== TraceStateView.BEFORE)
    ) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'Pre-answer checkpoint narration can expose another state.',
        'Use only the held before-state in checkpoint narration.',
        { sceneId: scene.sceneId, beatId: beat.beatId },
      );
    }
  }
  if (
    checkpoint.workedExplanation.some(
      (beat) => beat.traceEventId !== null && beat.traceEventId !== event.eventId,
    )
  ) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'A worked explanation narrates an unrelated trace update.',
      'Explain the held before/after update or use source-grounded narration without a trace marker.',
      location,
    );
  }
  const checkpointIndex = plan.scenes.indexOf(scene);
  const heldIndex = trace.events.indexOf(event);
  for (const earlier of plan.scenes.slice(0, checkpointIndex)) {
    if (
      earlier.kind === LessonTemplateKind.CODE_TRACE &&
      earlier.params.traceId === trace.traceId &&
      earlier.params.traceEventIds.some(
        (eventId) =>
          trace.events.findIndex((candidate) => candidate.eventId === eventId) >= heldIndex,
      )
    ) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'An earlier scene reveals a checkpoint update before the learner attempts it.',
        'End earlier playback before the held update.',
        { sceneId: earlier.sceneId },
      );
    }
  }
}

/** Deterministic release blockers supplement, rather than replace, independent teaching review. */
export function validateLessonPlan(input: LessonInput, plan: LessonPlan): ReviewIssue[] {
  const { issues, addIssue } = createIssueCollector();
  issues.push(...validateLessonInput(input));
  if (
    plan.sourcePacketHash !== input.sourcePacketHash ||
    plan.courseRevisionId !== input.courseRevisionId ||
    plan.objective !== input.objective ||
    plan.audience !== input.audience ||
    plan.language !== input.language
  ) {
    addIssue(
      ReviewCriterion.SOURCE_SUPPORT,
      'The lesson changes pinned input identity or teaching requirements.',
      'Preserve the approved input hash, revision, objective, audience, and language.',
    );
  }
  if (plan.teacherQuestions.length !== 0) {
    addIssue(
      ReviewCriterion.SOURCE_SUPPORT,
      'The candidate still has unresolved teacher questions.',
      'Resolve missing information before script approval.',
    );
  }
  checkUniqueIds(
    plan.scenes.map((scene) => scene.sceneId),
    'Scenes',
    addIssue,
  );
  checkUniqueIds(
    plan.checkpoints.map((checkpoint) => checkpoint.checkpointId),
    'Checkpoints',
    addIssue,
  );
  checkUniqueIds(
    plan.checkpoints.map((checkpoint) => checkpoint.sceneId),
    'Checkpoint scenes',
    addIssue,
  );
  const beats = [
    ...plan.scenes.flatMap((scene) => scene.narration),
    ...plan.checkpoints.flatMap((checkpoint) => checkpoint.workedExplanation),
  ];
  const visibleText = [
    plan.title,
    plan.objective,
    plan.audience,
    plan.reflectionPrompt,
    ...plan.teacherQuestions,
    ...plan.scenes.flatMap((scene) => [
      scene.title,
      ...(scene.kind === LessonTemplateKind.ANNOTATED_SOURCE
        ? scene.params.callouts.map((callout) => callout.label)
        : []),
    ]),
    ...beats.map((beat) => beat.text),
    ...plan.checkpoints.flatMap((checkpoint) => [
      checkpoint.question,
      ...checkpoint.options.map((option) => option.text),
      ...checkpoint.hints.map((hint) => hint.text),
    ]),
    ...input.codeBlocks.flatMap((block) => block.lines.map((line) => line.text)),
  ];
  if (visibleText.some((text) => !usesLessonGlyphs(text))) {
    addIssue(
      ReviewCriterion.READABILITY,
      'Instructional text includes glyphs outside the qualified English and Vietnamese font coverage.',
      'Use supported Latin/Vietnamese text and common punctuation, or qualify a broader font bundle first.',
    );
  }
  checkUniqueIds(
    beats.map((beat) => beat.beatId),
    'Narration beats',
    addIssue,
  );
  checkUniqueIds(
    plan.checkpoints.flatMap((checkpoint) => checkpoint.hints.map((hint) => hint.hintId)),
    'Hints',
    addIssue,
  );
  if (
    beats.length > 24 ||
    beats.reduce((total, beat) => total + Array.from(beat.text).length, 0) > 6000
  ) {
    addIssue(
      ReviewCriterion.TIMELINE,
      'The narration exceeds the bounded speech allowance.',
      'Use at most twenty-four beats and six thousand Unicode characters.',
    );
  }
  for (const scene of plan.scenes) {
    const location = { sceneId: scene.sceneId };
    const template = input.templates.find(
      (candidate) =>
        candidate.templateId === scene.kind && candidate.templateVersion === scene.templateVersion,
    );
    if (!template || !template.supportedLayoutVariants.includes(scene.layoutVariant)) {
      addIssue(
        ReviewCriterion.STYLE,
        'The scene selects an unqualified template or layout.',
        'Use a supplied template version and supported layout.',
        location,
      );
    }
    checkSourceRefs(input, scene.sourceRefs, addIssue, location);
    for (const beat of scene.narration) {
      checkNarration(input, beat, addIssue, scene);
    }
    if (scene.kind === LessonTemplateKind.CODE_TRACE) {
      const trace = input.traces.find(
        (candidate) =>
          candidate.traceId === scene.params.traceId &&
          candidate.codeBlockId === scene.params.codeBlockId,
      );
      const eventIndices = scene.params.traceEventIds.map(
        (eventId) => trace?.events.findIndex((event) => event.eventId === eventId) ?? -1,
      );
      if (
        !trace ||
        eventIndices.some(
          (index, position) => index < 0 || index <= (eventIndices[position - 1] ?? -1),
        )
      ) {
        addIssue(
          ReviewCriterion.TRACE_CORRECTNESS,
          'Scene events do not follow one canonical trace in order.',
          'Use the matching code/trace pair with increasing event positions.',
          location,
        );
      }
      if (
        !trace?.events.some((event) =>
          event.after.some((binding) => binding.name === scene.params.focusVariable),
        )
      ) {
        addIssue(
          ReviewCriterion.TRACE_CORRECTNESS,
          'The focus variable is absent from the canonical trace.',
          'Select a variable that exists in the demonstrated state.',
          location,
        );
      }
      if (
        scene.params.traceEventIds.some(
          (eventId) => !scene.narration.some((beat) => beat.traceEventId === eventId),
        )
      ) {
        addIssue(
          ReviewCriterion.TIMELINE,
          'A visible trace event has no approved narration cue.',
          'Attach each displayed state change to its exact narration beat.',
          location,
        );
      }
      for (const beat of scene.narration) {
        if (beat.traceEventId !== null && !scene.params.traceEventIds.includes(beat.traceEventId)) {
          addIssue(
            ReviewCriterion.TIMELINE,
            'Scene narration references an event outside its visible sequence.',
            'Narrate only events displayed by this scene.',
            { sceneId: scene.sceneId, beatId: beat.beatId },
          );
        }
      }
    } else if (scene.kind === LessonTemplateKind.ANNOTATED_SOURCE) {
      const asset = input.assets.find(
        (candidate) =>
          candidate.assetId === scene.params.assetId && candidate.kind === 'sourceFigure',
      );
      if (!asset) {
        addIssue(
          ReviewCriterion.ASSETS,
          'The annotated source has no approved source figure.',
          'Select an existing source figure with approved regions.',
          location,
        );
      }
      for (const callout of scene.params.callouts) {
        const region = asset?.regions.find((candidate) => candidate.regionId === callout.regionId);
        checkSourceRefs(input, callout.sourceRefs, addIssue, location);
        if (!region || callout.x !== region.anchorX || callout.y !== region.anchorY) {
          addIssue(
            ReviewCriterion.ASSETS,
            'A callout invents a figure region or anchor.',
            'Copy a supplied region and its approved coordinates.',
            location,
          );
        }
      }
    } else if (
      !plan.checkpoints.some(
        (checkpoint) =>
          checkpoint.checkpointId === scene.params.checkpointId &&
          checkpoint.sceneId === scene.sceneId,
      )
    ) {
      addIssue(
        ReviewCriterion.CHECKPOINT,
        'A checkpoint scene has no matching checkpoint.',
        'Use an existing checkpoint owned by this scene.',
        location,
      );
    }
  }
  for (const checkpoint of plan.checkpoints) {
    checkCheckpoint(input, plan, checkpoint, addIssue);
  }
  if (
    input.codeBlocks.some((block) => block.variantOfCodeBlockId !== null) &&
    !plan.checkpoints.some((checkpoint) => checkpoint.phase === CheckpointPhase.TRY)
  ) {
    addIssue(
      ReviewCriterion.CHECKPOINT,
      'An approved practice variant is supplied but independent practice is omitted.',
      'Include a Try checkpoint using the approved variant.',
    );
  }
  return issues.slice(0, 20);
}

/** Resolve grading only from the authoritative pinned input; prose and client supplied answers are never keys. */
export function readCheckpointAnswer(input: LessonInput, checkpoint: Checkpoint): number | string {
  const answer = checkpoint.answerRef;
  if (answer.kind === 'teacherAnswer') {
    const key = input.teacherAnswerKeys.find(
      (candidate) => candidate.answerKeyId === answer.answerKeyId,
    );
    if (
      key &&
      key.question === checkpoint.question &&
      JSON.stringify(key.options) === JSON.stringify(checkpoint.options)
    ) {
      return key.correctOptionId;
    }
  } else {
    const value = input.traces
      .find((trace) => trace.traceId === answer.traceId)
      ?.events.find((event) => event.eventId === answer.eventId)
      ?.after.find((binding) => binding.name === answer.variable)?.value;
    if (typeof value === 'number') {
      return value;
    }
  }
  throw new Error('The checkpoint has no authoritative answer.');
}
