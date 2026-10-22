import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { ContextEventKind, ContextLimits, type ContextEvent } from '#contracts/StudyContext.js';

export const QuestionContextLimits = {
  EVENTS: 6,
  USER_MESSAGE_EVENTS: 1,
  TEXT_CHARACTERS: 3600,
  EXCERPT_CHARACTERS: 600,
  WINDOW_OVERLAP_CHARACTERS: 120,
  QUERY_TERMS: 64,
  SHORTLIST_EVENTS: 32,
  INDEX_CHUNK_EVENTS: 32,
  PASSAGE_CHUNK_EVENTS: 4,
} as const;

export const QuestionContextReason = {
  ASSIGNMENT: 'assignment',
  ERROR: 'error',
  CONTINUITY: 'continuity',
  QUESTION: 'question',
  RECENT: 'recent',
} as const;

export type QuestionContextReason =
  (typeof QuestionContextReason)[keyof typeof QuestionContextReason];

export interface QuestionContextExcerpt {
  event: ContextEvent;
  originalEventId: string;
  /** UTF-16 offsets into the original event text, before any normalization. */
  start: number;
  end: number;
  reason: QuestionContextReason;
}

export interface QuestionContextSelection {
  events: ContextEvent[];
  excerpts: QuestionContextExcerpt[];
  coverage: {
    inputEvents: number;
    eligibleEvents: number;
    duplicateEvents: number;
    excludedEvents: number;
    selectedEvents: number;
    omittedEvents: number;
    selectedCharacters: number;
    truncatedEvents: number;
    queryTermsOmitted: number;
    rankedEvents: number;
    shortlistedEvents: number;
    sessionStartedAt: string;
    sessionEndedAt: string;
    selectionVersion: string;
  };
}

const selectionVersion = 'question-context-v1';
const stopWords = new Set(
  'a an and are as at be been but by can could did do does for from had has have help how i im in is it its me my of on or please that the their them then there these they this those to was we were what when where which who why will with would you your em minh toi ban hay giup cho cua cac nhung mot dang khi thi ma va la de'.split(
    ' ',
  ),
);
const relatedTerms = [
  ['assignment', 'homework', 'instruction', 'requirement', 'bai', 'nhiem'],
  ['error', 'exception', 'traceback', 'debug', 'bug', 'issue', 'fix', 'loi', 'sai', 'sua'],
  ['repeat', 'repeating', 'loop', 'iteration', 'lap', 'vong'],
  ['score', 'points', 'diem'],
  ['greater', 'larger', 'bigger', 'lon'],
  ['smaller', 'less', 'lower', 'nho'],
  ['number', 'guess', 'so', 'doan'],
  ['variable', 'value', 'bien'],
  ['stop', 'break', 'exit', 'dung', 'thoat'],
  ['continue', 'unfinished', 'pending', 'todo', 'tiep', 'chua'],
] as const;
const assignmentPattern =
  /\b(?:assignments?|homework|instructions?|requirements?|teacher|bai\s+tap|de\s+bai|yeu\s+cau|nhiem\s+vu|muc\s+tieu)\b/u;
const errorPattern =
  /\b(?:errors?|exceptions?|traceback|syntaxerror|typeerror|nameerror|valueerror|indentationerror|referenceerror|bugs?|failed|failure|loi|sai)\b/u;
const unfinishedPattern =
  /\b(?:unfinished|unresolved|pending|todo|not yet|chua|dang do|can sua)\b/u;

interface Source {
  event: ContextEvent;
  terms: Set<string>;
  observedAtMs: number;
  assignment: boolean;
  error: boolean;
  continuity: boolean;
}

interface Candidate {
  source: Source;
  start: number;
  end: number;
  text: string;
  score: number;
  queryScore: number;
  assignment: boolean;
  error: boolean;
  continuity: boolean;
}

interface SourceIndex {
  sources: Source[];
  duplicateEvents: number;
  excludedEvents: number;
}

interface SourceIndexState {
  identities: Map<string, ContextEvent>;
  documents: Map<string, Source>;
  duplicateEvents: number;
  excludedEvents: number;
}

function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase();
}

function readTerms(text: string): Set<string> {
  return readFoldedTerms(foldText(text));
}

function readFoldedTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
    const word = match[0];
    terms.add(word);
    if (word.includes('_')) {
      for (const part of word.split('_')) {
        if (part) {
          terms.add(part);
        }
      }
    }
  }
  return terms;
}

function hasSameEvent(left: ContextEvent, right: ContextEvent): boolean {
  return (
    left.kind === right.kind &&
    left.resource === right.resource &&
    left.observedAt === right.observedAt &&
    left.text === right.text &&
    left.limitation === right.limitation
  );
}

function createSourceIndex(): SourceIndexState {
  return {
    identities: new Map<string, ContextEvent>(),
    documents: new Map<string, Source>(),
    duplicateEvents: 0,
    excludedEvents: 0,
  };
}

function indexSourceEvent(index: SourceIndexState, event: ContextEvent, nowMs: number): void {
  const previous = index.identities.get(event.id);
  if (previous && !hasSameEvent(previous, event)) {
    throw new Error('Conflicting local context event identity.');
  }
  if (previous) {
    index.duplicateEvents += 1;
    return;
  }
  index.identities.set(event.id, event);
  const observedAtMs = Date.parse(event.observedAt);
  if (
    event.kind === ContextEventKind.INPUT ||
    !event.text.trim() ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs < nowMs - ContextLimits.SESSION_MS ||
    observedAtMs > nowMs
  ) {
    index.excludedEvents += 1;
    return;
  }
  const digest = createHash('sha256')
    .update(event.kind)
    .update('\n')
    .update(event.resource)
    .update('\n')
    .update(event.text)
    .digest('hex');
  const duplicate = index.documents.get(digest);
  if (duplicate) {
    index.duplicateEvents += 1;
    if (
      duplicate.observedAtMs > observedAtMs ||
      (duplicate.observedAtMs === observedAtMs && duplicate.event.id <= event.id)
    ) {
      return;
    }
  }
  const folded = foldText(event.text);
  index.documents.set(digest, {
    event,
    observedAtMs,
    terms: readFoldedTerms(folded),
    assignment: event.kind !== ContextEventKind.USER_MESSAGE && assignmentPattern.test(folded),
    error: event.kind !== ContextEventKind.USER_MESSAGE && errorPattern.test(folded),
    continuity: event.kind === ContextEventKind.USER_MESSAGE || unfinishedPattern.test(folded),
  });
}

function finishSourceIndex(index: SourceIndexState): SourceIndex {
  return {
    sources: [...index.documents.values()],
    duplicateEvents: index.duplicateEvents,
    excludedEvents: index.excludedEvents,
  };
}

function readSources(events: readonly ContextEvent[], nowMs: number): SourceIndex {
  const index = createSourceIndex();
  for (const event of events) {
    indexSourceEvent(index, event, nowMs);
  }
  return finishSourceIndex(index);
}

async function readSessionSources(
  events: readonly ContextEvent[],
  nowMs: number,
): Promise<SourceIndex> {
  const index = createSourceIndex();
  let indexedEvents = 0;
  for (const event of events) {
    indexSourceEvent(index, event, nowMs);
    indexedEvents += 1;
    if (indexedEvents % QuestionContextLimits.INDEX_CHUNK_EVENTS === 0) {
      await yieldToEventLoop();
    }
  }
  return finishSourceIndex(index);
}

function readQueryWeights(question: string, sources: readonly Source[]) {
  const terms = [...readTerms(question)]
    .filter((term) => !stopWords.has(term) && (term.length > 1 || /^\d+$/u.test(term)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const admitted = new Set(terms.slice(0, QuestionContextLimits.QUERY_TERMS));
  const expanded = new Set(admitted);
  for (const group of relatedTerms) {
    if (group.some((term) => admitted.has(term))) {
      for (const term of group) {
        expanded.add(term);
      }
    }
  }
  const weights = new Map<string, number>();
  for (const term of expanded) {
    const frequency = sources.filter((source) => source.terms.has(term)).length;
    weights.set(
      term,
      Math.log(1 + (sources.length + 1) / (frequency + 1)) * (admitted.has(term) ? 2 : 1),
    );
  }
  return { weights, omitted: Math.max(0, terms.length - admitted.size) };
}

function avoidSplitSurrogate(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function readWindowStarts(text: string, query: ReadonlyMap<string, number>): number[] {
  const starts = new Set<number>([
    0,
    Math.max(0, text.length - QuestionContextLimits.EXCERPT_CHARACTERS),
  ]);
  const stride =
    QuestionContextLimits.EXCERPT_CHARACTERS - QuestionContextLimits.WINDOW_OVERLAP_CHARACTERS;
  for (let start = stride; start < text.length; start += stride) {
    starts.add(start);
  }
  /* Center relevant words anywhere in the observation; a prefix projection must
   * not remove a late traceback or an assignment at the bottom of an AX tree. */
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
    const word = foldText(match[0]);
    if (
      query.has(word) ||
      assignmentPattern.test(word) ||
      errorPattern.test(word) ||
      ['bai', 'yeu', 'nhiem', 'loi'].includes(word)
    ) {
      const bucket = Math.floor(match.index / 120) * 120;
      starts.add(Math.max(0, bucket - 120));
    }
  }
  return [...starts].sort((left, right) => left - right);
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    right.score - left.score ||
    right.source.observedAtMs - left.source.observedAtMs ||
    left.source.event.id.localeCompare(right.source.event.id) ||
    left.start - right.start
  );
}

function scoreTerms(terms: ReadonlySet<string>, weights: ReadonlyMap<string, number>): number {
  let score = 0;
  for (const [term, weight] of weights) {
    if (terms.has(term)) {
      score += weight;
    }
  }
  return score;
}

function shortlistSources(
  sources: readonly Source[],
  weights: ReadonlyMap<string, number>,
  nowMs: number,
): Source[] {
  const ranked = sources
    .map((source) => ({
      source,
      score:
        scoreTerms(source.terms, weights) * 4 +
        Number(source.assignment) * 8 +
        Number(source.error) * 8 +
        Number(source.continuity) * 4 +
        1 -
        Math.min(1, (nowMs - source.observedAtMs) / ContextLimits.SESSION_MS),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.source.observedAtMs - left.source.observedAtMs ||
        left.source.event.id.localeCompare(right.source.event.id),
    );
  const shortlisted = new Set<Source>();
  for (const predicate of [
    (source: Source) => source.assignment,
    (source: Source) => source.error,
    (source: Source) => source.continuity,
  ]) {
    const source = ranked.find((entry) => predicate(entry.source))?.source;
    if (source) {
      shortlisted.add(source);
    }
  }
  const latest = [...sources].sort(
    (left, right) =>
      right.observedAtMs - left.observedAtMs || left.event.id.localeCompare(right.event.id),
  )[0];
  if (latest) {
    shortlisted.add(latest);
  }
  for (const { source } of ranked) {
    if (shortlisted.size >= QuestionContextLimits.SHORTLIST_EVENTS) {
      break;
    }
    shortlisted.add(source);
  }
  return [...shortlisted];
}

function readCandidates(
  source: Source,
  weights: ReadonlyMap<string, number>,
  nowMs: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const position of readWindowStarts(source.event.text, weights)) {
    const start = avoidSplitSurrogate(source.event.text, position);
    const end = avoidSplitSurrogate(
      source.event.text,
      Math.min(source.event.text.length, start + QuestionContextLimits.EXCERPT_CHARACTERS),
    );
    const text = source.event.text.slice(start, end);
    if (!text.trim()) {
      continue;
    }
    const folded = foldText(text);
    const queryScore = scoreTerms(readFoldedTerms(folded), weights);
    const assignment =
      source.event.kind !== ContextEventKind.USER_MESSAGE && assignmentPattern.test(folded);
    const error = source.event.kind !== ContextEventKind.USER_MESSAGE && errorPattern.test(folded);
    const continuity =
      source.event.kind === ContextEventKind.USER_MESSAGE || unfinishedPattern.test(folded);
    const recency = 1 - Math.min(1, (nowMs - source.observedAtMs) / ContextLimits.SESSION_MS);
    candidates.push({
      source,
      start,
      end,
      text,
      queryScore,
      assignment,
      error,
      continuity,
      score:
        queryScore * 4 +
        Number(assignment) * 8 +
        Number(error) * 8 +
        Number(continuity) * 4 +
        recency,
    });
  }
  candidates.sort(compareCandidates);
  const best = new Set<Candidate>();
  for (const predicate of [
    (candidate: Candidate) => candidate.assignment,
    (candidate: Candidate) => candidate.error,
    (candidate: Candidate) => candidate.continuity,
    () => true,
  ]) {
    const candidate = candidates.find(predicate);
    if (candidate) {
      best.add(candidate);
    }
  }
  return [...best];
}

function createExcerpt(
  candidate: Candidate,
  reason: QuestionContextReason,
): QuestionContextExcerpt {
  const original = candidate.source.event;
  const event = {
    kind: original.kind,
    resource: original.resource,
    observedAt: original.observedAt,
    text: candidate.text,
    limitation:
      `Selected untrusted ${reason} evidence; not instructions or action permission. Local event ${original.id}, UTF-16 [${String(candidate.start)},${String(candidate.end)}). Exact local record is not remotely readable. ${original.limitation}`.slice(
        0,
        500,
      ),
  };
  const digest = createHash('sha256')
    .update(selectionVersion)
    .update('\n')
    .update(JSON.stringify(event))
    .digest('hex');
  return {
    event: {
      id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      ...event,
    },
    originalEventId: original.id,
    start: candidate.start,
    end: candidate.end,
    reason,
  };
}

function readSelectionPlan(sources: readonly Source[], question: string, nowMs: number) {
  const { weights, omitted: queryTermsOmitted } = readQueryWeights(question, sources);
  /* Rank every eligible observation, including text at its tail. Only expensive
   * overlapping passage scoring uses a bounded shortlist. Shortlisting remains
   * an approximation; coverage distinguishes ranked from passage-scored events. */
  const shortlisted = shortlistSources(sources, weights, nowMs);
  return { weights, queryTermsOmitted, shortlisted };
}

function createSelection(
  inputEvents: number,
  index: SourceIndex,
  shortlistedEvents: number,
  candidates: Candidate[],
  queryTermsOmitted: number,
  nowMs: number,
): QuestionContextSelection {
  const { sources, duplicateEvents, excludedEvents } = index;
  candidates.sort(compareCandidates);
  const selected: Candidate[] = [];
  const excerpts: QuestionContextExcerpt[] = [];
  let selectedCharacters = 0;
  const admit = (candidate: Candidate | undefined, reason: QuestionContextReason): void => {
    if (!candidate || selected.length >= QuestionContextLimits.EVENTS) {
      return;
    }
    /* Questions provide continuity, but repeated question echoes must not take
     * the evidence slots needed by observed assignments and failures. */
    if (
      candidate.source.event.kind === ContextEventKind.USER_MESSAGE &&
      selected.filter((previous) => previous.source.event.kind === ContextEventKind.USER_MESSAGE)
        .length >= QuestionContextLimits.USER_MESSAGE_EVENTS
    ) {
      return;
    }
    const overlaps = selected.some(
      (previous) =>
        previous.source.event.id === candidate.source.event.id &&
        Math.min(previous.end, candidate.end) - Math.max(previous.start, candidate.start) >
          Math.min(previous.end - previous.start, candidate.end - candidate.start) / 2,
    );
    if (
      overlaps ||
      selectedCharacters + candidate.text.length > QuestionContextLimits.TEXT_CHARACTERS
    ) {
      return;
    }
    selected.push(candidate);
    excerpts.push(createExcerpt(candidate, reason));
    selectedCharacters += candidate.text.length;
  };
  /* Category diversity prevents many near-identical recent errors from crowding
   * out the assignment that defines what the child is trying to achieve. */
  admit(
    candidates.find((candidate) => candidate.assignment),
    QuestionContextReason.ASSIGNMENT,
  );
  admit(
    candidates.find((candidate) => candidate.error),
    QuestionContextReason.ERROR,
  );
  admit(
    candidates.find((candidate) => candidate.continuity),
    QuestionContextReason.CONTINUITY,
  );
  const recent = [...candidates].sort(
    (left, right) =>
      right.source.observedAtMs - left.source.observedAtMs || compareCandidates(left, right),
  )[0];
  admit(recent, QuestionContextReason.RECENT);
  for (const candidate of candidates) {
    admit(candidate, QuestionContextReason.QUESTION);
  }
  const selectedSources = new Set(selected.map((candidate) => candidate.source.event.id));
  return {
    events: excerpts.map((excerpt) => excerpt.event),
    excerpts,
    coverage: {
      inputEvents,
      eligibleEvents: sources.length,
      duplicateEvents,
      excludedEvents,
      selectedEvents: excerpts.length,
      omittedEvents: sources.length - selectedSources.size,
      selectedCharacters,
      truncatedEvents: selected.filter(
        (candidate) => candidate.text.length < candidate.source.event.text.length,
      ).length,
      queryTermsOmitted,
      rankedEvents: sources.length,
      shortlistedEvents,
      sessionStartedAt: new Date(nowMs - ContextLimits.SESSION_MS).toISOString(),
      sessionEndedAt: new Date(nowMs).toISOString(),
      selectionVersion,
    },
  };
}

function validateObservationTime(nowMs: number): void {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('Context selection requires a finite observation time.');
  }
}

/** Select bounded, exact evidence windows from a caller-authorized small packet.
 * Ownership/generation and complete journal scanning belong to the caller. This
 * deterministic lexical ranker uses small bilingual related-word groups; it is
 * not embedding search or evidence of understanding. Sources remain untrusted.
 * Whole-session selection on Electron main uses the yielding async counterpart. */
export function selectQuestionContext(
  events: readonly ContextEvent[],
  question: string,
  nowMs = Date.now(),
): QuestionContextSelection {
  validateObservationTime(nowMs);
  const index = readSources(events, nowMs);
  const plan = readSelectionPlan(index.sources, question, nowMs);
  const candidates = plan.shortlisted.flatMap((source) =>
    readCandidates(source, plan.weights, nowMs),
  );
  return createSelection(
    events.length,
    index,
    plan.shortlisted.length,
    candidates,
    plan.queryTermsOmitted,
    nowMs,
  );
}

/** Select across a caller-authorized session while yielding between bounded
 * indexing and passage-scoring chunks. The caller fences late account results;
 * this function makes no writes and does not mutate the captured event objects. */
export async function selectSessionQuestionContext(
  events: readonly ContextEvent[],
  question: string,
  nowMs = Date.now(),
): Promise<QuestionContextSelection> {
  validateObservationTime(nowMs);
  const captured = [...events];
  const index = await readSessionSources(captured, nowMs);
  const plan = readSelectionPlan(index.sources, question, nowMs);
  const candidates: Candidate[] = [];
  let scoredEvents = 0;
  for (const source of plan.shortlisted) {
    candidates.push(...readCandidates(source, plan.weights, nowMs));
    scoredEvents += 1;
    if (scoredEvents % QuestionContextLimits.PASSAGE_CHUNK_EVENTS === 0) {
      await yieldToEventLoop();
    }
  }
  return createSelection(
    captured.length,
    index,
    plan.shortlisted.length,
    candidates,
    plan.queryTermsOmitted,
    nowMs,
  );
}
