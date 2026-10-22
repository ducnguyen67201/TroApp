import { createHash } from 'node:crypto';
import { ContextEventKind, type ContextEvent } from '../../../src/contracts/StudyContext.js';

export interface QuestionContextFact {
  id: string;
  marker: string;
}

export interface QuestionContextAsk {
  id: string;
  question: string;
  facts: QuestionContextFact[];
}

export interface QuestionContextCase {
  id: string;
  batches: ContextEvent[][];
  asks: QuestionContextAsk[];
  acknowledgeBeforeAsk?: boolean;
  restartBeforeAsk?: boolean;
}

export function createQuestionContextId(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function createEvent(
  caseId: string,
  sequence: number,
  text: string,
  nowMs: number,
  kind: ContextEvent['kind'] = ContextEventKind.OBSERVATION,
): ContextEvent {
  return {
    id: createQuestionContextId(`${caseId}:${String(sequence)}`),
    kind,
    resource: kind === ContextEventKind.INPUT ? 'physical-input' : 'authored-study-evidence',
    observedAt: new Date(nowMs - 2_000_000 + sequence * 1000).toISOString(),
    text,
    limitation: 'Synthetic evidence only; no native capture or proof of learning.',
  };
}

function createBatches(events: ContextEvent[]): ContextEvent[][] {
  return Array.from({ length: Math.ceil(events.length / 20) }, (_, index) =>
    events.slice(index * 20, index * 20 + 20),
  );
}

const assignment = { id: 'movement-repetitions', marker: 'TRO_EVAL_ASSIGN_REPEAT_7' };
const error = { id: 'score-type-error', marker: 'TRO_EVAL_ERROR_STRING_PLUS_INT' };
const expected = { id: 'expected-three-turn-score', marker: 'TRO_EVAL_EXPECTED_SCORE_3' };
const loop = { id: 'correct-guess-loop', marker: 'TRO_EVAL_CORRECT_GUESS_BREAK' };
const assignmentText = `Assignment from the teacher: repeat the Scratch sprite movement seven times, then stop. ${assignment.marker}`;
const errorText = `Python score error: TypeError: can only concatenate str (not int) to str. input() returned text before score addition. ${error.marker}`;
const assignmentAsk: QuestionContextAsk = {
  id: 'Assignment',
  question: 'How many times did the Scratch movement assignment require me to repeat the movement?',
  facts: [assignment],
};

function createThreeHourCase(nowMs: number): QuestionContextCase {
  const batches = Array.from({ length: 1080 }, (_, batch) => {
    /* Keep capture timestamps one minute inside each session boundary so disk
       setup time does not expire the earliest fixture while the benchmark runs. */
    const observedAt = new Date(
      nowMs - 10_800_000 + 60_000 + batch * (10_680_000 / 1079),
    ).toISOString();
    const events: ContextEvent[] = Array.from({ length: 18 }, (_, index) => ({
      id: createQuestionContextId(`ThreeHourSession:${String(batch)}:input:${String(index)}`),
      kind: ContextEventKind.INPUT,
      resource: 'physical-input',
      observedAt,
      text: JSON.stringify({
        kind: index % 3 ? 'release' : 'scroll',
        point: { x: (120 + index) / 1000, y: (340 + (batch % 100)) / 1000 },
        target: 'unknown',
      }),
      limitation: 'Synthetic input attempt; target and acceptance unknown.',
    }));
    let state = batch + 1;
    let text =
      batch === 0
        ? `${assignmentText}\n`
        : batch === 540
          ? `${errorText}\n`
          : batch === 1079
            ? `The number guessing game loop does not stop after a correct guess; its exit is missing. ${loop.marker}\n`
            : '';
    while (text.length < 7900) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      text += `AXNode role=TextField label=Exercise${String(batch)} state=${String(state)} value=while_if_else_python_scratch\n`;
    }
    text = text.slice(0, 8000);
    if (batch === 1079) {
      text += `\nInstruction: after three turns the expected score is 3. ${expected.marker}`;
    }
    events.push({
      id: createQuestionContextId(`ThreeHourSession:${String(batch)}:observation`),
      kind: ContextEventKind.OBSERVATION,
      resource: 'foreground-accessibility',
      observedAt,
      text,
      limitation: 'Synthetic AX-like text; no real application capture or learning evidence.',
    });
    return events;
  });
  return {
    id: 'ThreeHourSession',
    batches,
    asks: [
      {
        id: 'ColdAssignmentAndError',
        question:
          'I need to continue the Scratch movement assignment. How many repetitions did it require? Also what Python TypeError happened when adding my score?',
        facts: [assignment, error],
      },
      {
        id: 'WarmDifferentQuestion',
        question: 'After three turns, what score did the instructions expect?',
        facts: [expected],
      },
      {
        id: 'WarmLoopError',
        question: 'Why does my number guessing game keep looping even after a correct guess?',
        facts: [loop],
      },
    ],
  };
}

/** Authored diagnostic markers measure delivery, never answer quality. Questions
 * use natural language and do not contain those marker strings. */
export function createQuestionContextCases(
  nowMs: number,
  includeThreeHour = true,
): QuestionContextCase[] {
  const events = (caseId: string, count: number): ContextEvent[] =>
    Array.from({ length: count }, (_, index) =>
      createEvent(
        caseId,
        index + 1,
        `Unrelated interface panel ${String(index)}. ${'Visible toolbar and document navigation. '.repeat(65)}`,
        nowMs,
      ),
    );
  return [
    {
      id: 'RecentAssignment',
      batches: [[createEvent('RecentAssignment', 0, assignmentText, nowMs)]],
      asks: [assignmentAsk],
    },
    {
      id: 'EarlierAssignmentUnderNoise',
      batches: createBatches([
        createEvent('EarlierAssignmentUnderNoise', 0, assignmentText, nowMs),
        ...events('EarlierAssignmentUnderNoise', 80),
      ]),
      asks: [assignmentAsk],
    },
    {
      id: 'FactBeyondObservationExcerpt',
      batches: [
        [
          createEvent(
            'FactBeyondObservationExcerpt',
            0,
            `${'Unrelated layout information. '.repeat(90)}\n${assignmentText}`,
            nowMs,
          ),
        ],
      ],
      asks: [assignmentAsk],
    },
    {
      id: 'FactBeyondInitialSourceProjection',
      batches: [
        [
          createEvent(
            'FactBeyondInitialSourceProjection',
            0,
            `${'x'.repeat(1400)}\n${assignmentText}`,
            nowMs,
          ),
        ],
      ],
      asks: [assignmentAsk],
    },
    {
      id: 'EarlierErrorAmongRepeatedNoise',
      batches: Array.from({ length: 80 }, (_, index) => [
        createEvent(
          'EarlierErrorAmongRepeatedNoise',
          index,
          index === 12
            ? errorText
            : `Preview network error: timeout. ${'The preview panel could not refresh. '.repeat(25)}`,
          nowMs,
        ),
      ]),
      asks: [
        {
          id: 'TypeError',
          question:
            'My Python score addition fails with a TypeError after input. What error did I hit?',
          facts: [error],
        },
      ],
    },
    {
      id: 'AcknowledgedHistoryAfterRestart',
      batches: [
        [
          createEvent('AcknowledgedHistoryAfterRestart', 0, assignmentText, nowMs),
          createEvent('AcknowledgedHistoryAfterRestart', 1, errorText, nowMs),
        ],
      ],
      acknowledgeBeforeAsk: true,
      restartBeforeAsk: true,
      asks: [
        assignmentAsk,
        {
          id: 'DifferentQuestion',
          question: 'What Python TypeError did I encounter when adding the score?',
          facts: [error],
        },
      ],
    },
    {
      id: 'RepeatedQuestionsKeepAssignment',
      batches: [[createEvent('RepeatedQuestionsKeepAssignment', 0, assignmentText, nowMs)]],
      asks: Array.from({ length: 22 }, (_, index) => ({
        id: `Attempt${String(index + 1)}`,
        question: `For my next attempt ${String(index + 1)}, how many times should I repeat the Scratch movement assignment?`,
        facts: [assignment],
      })),
    },
    {
      id: 'InputStorm',
      batches: createBatches([
        ...Array.from({ length: 1000 }, (_, index) =>
          createEvent(
            'InputStorm',
            index,
            JSON.stringify({ kind: index % 2 ? 'release' : 'scroll', point: null }),
            nowMs,
            ContextEventKind.INPUT,
          ),
        ),
        createEvent('InputStorm', 1000, assignmentText, nowMs),
      ]),
      asks: [assignmentAsk],
    },
    ...(includeThreeHour ? [createThreeHourCase(nowMs)] : []),
  ];
}
