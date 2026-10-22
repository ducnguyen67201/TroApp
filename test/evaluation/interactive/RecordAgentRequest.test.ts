import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TeachingObservationKind } from '../../../src/contracts/TeachingObservation.js';
import {
  AgentRequestOutputKind,
  redactAgentRequestOutput,
  redactEvaluationText,
} from './AgentRequestOutput.js';
import {
  InteractiveAgentMessageKind,
  type InteractiveAgentOutput,
} from './InteractiveAgentProtocol.js';
import { AgentRequestRecorder } from './RecordAgentRequest.js';
import { gradeAgentRequest } from './GradeAgentRequest.js';
import { AgentTaskMode } from '../../../src/contracts/CursorCompanion.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRecorder(
  request = 'Help me debug my score.',
  credential: string | null = null,
) {
  const root = await mkdtemp(join(tmpdir(), 'TroRequestRecorder-'));
  directories.push(root);
  const trialId = randomUUID();
  const directory = join(root, 'Trial');
  return {
    recorder: await AgentRequestRecorder.create(directory, trialId, request, credential),
    directory,
    trialId,
  };
}

function createFinalOutput(trialId: string, sequence: number): InteractiveAgentOutput {
  return {
    kind: InteractiveAgentMessageKind.OUTPUT,
    trialId,
    sequence,
    elapsedMs: sequence,
    output: {
      kind: AgentRequestOutputKind.FINAL,
      resultKind: 'teaching',
      answer: 'Try the program again.',
      answerTruncated: false,
      failed: false,
    },
  };
}

it('appends every streamed observation beyond the runtime history ring and flushes before coverage passes', async () => {
  const { recorder, directory, trialId } = await createRecorder();
  const lessonId = randomUUID();
  for (let sequence = 1; sequence <= 50; sequence += 1) {
    recorder.appendWorkerOutput(
      {
        kind: InteractiveAgentMessageKind.OUTPUT,
        trialId,
        sequence,
        elapsedMs: sequence,
        output: {
          kind: AgentRequestOutputKind.TEACHING,
          observation: {
            kind: TeachingObservationKind.CUE_REFUSED,
            sequence,
            elapsedMs: sequence,
            lessonId,
            stepId: null,
            presentationId: null,
            captureId: null,
            reason: 'fresh_observation_required',
          },
        },
      },
      sequence + 10,
    );
  }
  recorder.appendWorkerOutput(createFinalOutput(trialId, 51), 61);
  expect(await recorder.finish(51)).toMatchObject({
    traceComplete: true,
    workerOutputs: 51,
    recordsWritten: 51,
    recordsDropped: 0,
  });
  expect(recorder.readTeachingObservations()).toHaveLength(50);
  const events = await readFile(join(directory, 'Events.jsonl'), 'utf8');
  expect(events.trim().split('\n')).toHaveLength(51);
  expect(events).toContain('"sequence":1,');
  expect(events).toContain('Try the program again.');
});

it.each([
  'missing-terminal',
  'missing-accounting',
  'wrong-count',
  'rejected-record',
  'wrong-trial',
  'time-reversal',
  'after-terminal',
  'truncated-answer',
])('keeps incomplete %s recording from proving absence', async (failure) => {
  const { recorder, trialId } = await createRecorder();
  const final = createFinalOutput(trialId, 1);
  if (failure === 'rejected-record') {
    recorder.recordRejectedOutput();
  }
  if (failure === 'wrong-trial') {
    final.trialId = randomUUID();
  }
  if (failure === 'truncated-answer' && final.output.kind === AgentRequestOutputKind.FINAL) {
    final.output.answerTruncated = true;
  }
  if (failure !== 'missing-terminal') {
    recorder.appendWorkerOutput(final, 1);
  }
  if (failure === 'after-terminal' || failure === 'time-reversal') {
    recorder.appendWorkerOutput(
      { ...createFinalOutput(trialId, 2), elapsedMs: failure === 'time-reversal' ? 0 : 2 },
      2,
    );
  }
  const expectedCount = failure === 'missing-accounting' ? null : failure === 'wrong-count' ? 2 : 1;
  expect((await recorder.finish(expectedCount)).traceComplete).toBe(false);
});

it('removes an opaque scoped credential from explicit request/output artifacts', async () => {
  const credential = 'opaque-synthetic-scoped-token';
  const { recorder, directory, trialId } = await createRecorder(
    `Do not repeat ${credential}.`,
    credential,
  );
  const output = createFinalOutput(trialId, 1);
  if (output.output.kind === AgentRequestOutputKind.FINAL) {
    output.output.answer = `Never publish ${credential}, sk-synthetic-secret or Bearer fake-token.`;
  }
  recorder.appendWorkerOutput(
    { ...output, output: redactAgentRequestOutput(output.output, credential) },
    1,
  );
  expect((await recorder.finish(1)).traceComplete).toBe(true);
  const artifacts = (
    await Promise.all(
      ['Request.json', 'Events.jsonl'].map((file) => readFile(join(directory, file), 'utf8')),
    )
  ).join('\n');
  expect(artifacts).not.toContain(credential);
  expect(artifacts).not.toContain('sk-synthetic-secret');
  expect(artifacts).not.toContain('fake-token');
  expect(artifacts).toContain('credential removed');
});

it('removes media URLs without changing ordinary instructions or IDs', () => {
  expect(redactEvaluationText('Select reset, then Run.')).toBe('Select reset, then Run.');
  expect(redactEvaluationText('data:image/png;base64,secret-pixels')).toBe('[media removed]');
});

it('writes a readable final output and evidence checklist without inventing live grades', async () => {
  const { recorder, directory, trialId } = await createRecorder();
  recorder.appendWorkerOutput(createFinalOutput(trialId, 1), 1);
  const summary = await recorder.finish(1);
  const checklist = gradeAgentRequest({
    trial: null,
    taskMode: AgentTaskMode.EXECUTE,
    observations: [],
    traceComplete: false,
    observedOutcomeMatches: null,
  });
  await recorder.saveEvaluation(checklist, summary);
  expect(await readFile(join(directory, 'Outputs.md'), 'utf8')).toContain('Try the program again.');
  const readable = await readFile(join(directory, 'Checklist.md'), 'utf8');
  expect(readable).toContain('Test A [UNASSESSED]');
  expect(readable).toContain('Test J [UNASSESSED]');
  expect(await readFile(join(directory, 'Checklist.json'), 'utf8')).toContain('"recording"');
});
