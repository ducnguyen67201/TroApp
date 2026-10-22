import { mkdir, open, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { TeachingObservation } from '../../../src/contracts/TeachingObservation.js';
import { TeachingObservationKind } from '../../../src/contracts/TeachingObservation.js';
import { AgentRequestOutputKind, redactEvaluationText } from './AgentRequestOutput.js';
import {
  InteractiveAgentOutputSchema,
  type InteractiveAgentOutput,
} from './InteractiveAgentProtocol.js';
import { formatAgentRequestChecklist, type AgentRequestChecklist } from './GradeAgentRequest.js';
import { WorkspaceStateSchema, type WorkspaceState } from './InteractiveStudyWorkspace.js';

const RecordingLimits = {
  QUEUED_BYTES: 4 * 1024 * 1024,
  TOTAL_BYTES: 64 * 1024 * 1024,
  OBSERVATIONS: 10_000,
} as const;

export interface AgentRequestRecordingSummary {
  traceComplete: boolean;
  workerOutputs: number;
  recordsWritten: number;
  recordsDropped: number;
  writeFailed: boolean;
  terminalOutputObserved: boolean;
}

/** Append-only benchmark artifacts. The synchronous callback validates/enqueues
 * bounded records; file I/O runs serially outside the tutor callback. Capacity or
 * disk failures make coverage incomplete and never stop the tutoring/model run. */
export class AgentRequestRecorder {
  private pending: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private totalBytes = 0;
  private recordsWritten = 0;
  private recordsDropped = 0;
  private writeFailed = false;
  private closed = false;
  private ordered = true;
  private workerOutputs = 0;
  private previousWorkerMs = 0;
  private terminalOutputObserved = false;
  private previousWorkspace: string | null = null;
  private readonly observations: TeachingObservation[] = [];
  private readonly readableOutputs: string[] = [];

  private constructor(
    private readonly file: FileHandle,
    readonly directory: string,
    private readonly trialId: string,
    private readonly credential: string | null,
  ) {}

  static async create(
    directory: string,
    trialId: string,
    request: string,
    credential: string | null = null,
  ): Promise<AgentRequestRecorder> {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, 'Request.json'),
      `${JSON.stringify({ trialId, request: redactEvaluationText(request, credential), audioIncluded: false }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const file = await open(join(directory, 'Events.jsonl'), 'wx', 0o600);
    return new AgentRequestRecorder(file, directory, trialId, credential);
  }

  recordRejectedOutput(): void {
    this.recordsDropped += 1;
  }

  appendWorkerOutput(input: InteractiveAgentOutput, receivedElapsedMs: number): void {
    const parsed = InteractiveAgentOutputSchema.safeParse(input);
    if (!parsed.success || parsed.data.trialId !== this.trialId || this.closed) {
      this.recordRejectedOutput();
      return;
    }
    const event = parsed.data;
    if (
      event.sequence !== this.workerOutputs + 1 ||
      event.elapsedMs < this.previousWorkerMs ||
      this.terminalOutputObserved
    ) {
      this.ordered = false;
    }
    this.previousWorkerMs = event.elapsedMs;
    this.workerOutputs += 1;
    const output = event.output;
    if (output.kind === AgentRequestOutputKind.TEACHING) {
      if (this.observations.length < RecordingLimits.OBSERVATIONS) {
        this.observations.push(output.observation);
      } else {
        this.recordRejectedOutput();
      }
      const observation = output.observation;
      if (observation.kind === TeachingObservationKind.CUE_PUBLISHED) {
        this.appendReadable(
          `Teaching ${String(observation.sequence)}: ${JSON.stringify(observation.message)}`,
        );
      }
    }
    if (output.kind === AgentRequestOutputKind.FINAL) {
      this.terminalOutputObserved = true;
      if (output.answerTruncated) {
        this.recordRejectedOutput();
      }
      this.appendReadable(
        `Final response (${output.resultKind ?? 'missing'}): ${output.answer ?? '(no public answer)'}`,
      );
    }
    this.enqueue({ source: 'worker', receivedElapsedMs, ...event });
  }

  appendWorkspace(state: WorkspaceState, receivedElapsedMs: number): void {
    const validated = WorkspaceStateSchema.parse(state);
    if (validated.trialId !== this.trialId) {
      this.recordRejectedOutput();
      return;
    }
    const serialized = JSON.stringify(validated);
    if (serialized !== this.previousWorkspace) {
      this.previousWorkspace = serialized;
      this.enqueue({ source: 'workspace', receivedElapsedMs, state: validated });
    }
  }

  readTeachingObservations(): readonly TeachingObservation[] {
    return this.observations;
  }

  async finish(expectedWorkerOutputs: number | null): Promise<AgentRequestRecordingSummary> {
    this.closed = true;
    await this.pending;
    try {
      await this.file.close();
    } catch {
      this.writeFailed = true;
    }
    return {
      traceComplete:
        expectedWorkerOutputs !== null &&
        expectedWorkerOutputs === this.workerOutputs &&
        this.terminalOutputObserved &&
        this.ordered &&
        !this.writeFailed &&
        this.recordsDropped === 0,
      workerOutputs: this.workerOutputs,
      recordsWritten: this.recordsWritten,
      recordsDropped: this.recordsDropped,
      writeFailed: this.writeFailed,
      terminalOutputObserved: this.terminalOutputObserved,
    };
  }

  async saveEvaluation(
    checklist: AgentRequestChecklist,
    summary: AgentRequestRecordingSummary,
  ): Promise<void> {
    await writeFile(
      join(this.directory, 'Checklist.json'),
      `${JSON.stringify({ ...checklist, recording: summary }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(this.directory, 'Checklist.md'),
      `${formatAgentRequestChecklist(checklist)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(this.directory, 'Outputs.md'),
      `# Recorded public outputs\n\n${this.readableOutputs.join('\n\n')}\n\nFull public output and independent state records: Events.jsonl. No SDK history or screenshot pixels are recorded.\n`,
      { mode: 0o600 },
    );
  }

  private appendReadable(text: string): void {
    if (this.readableOutputs.length < RecordingLimits.OBSERVATIONS) {
      this.readableOutputs.push(redactEvaluationText(text));
    }
  }

  private enqueue(value: unknown): void {
    const line = `${JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'string' ? redactEvaluationText(entry, this.credential) : entry))}\n`;
    const bytes = Buffer.byteLength(line);
    if (
      this.closed ||
      this.writeFailed ||
      this.queuedBytes + bytes > RecordingLimits.QUEUED_BYTES ||
      this.totalBytes + bytes > RecordingLimits.TOTAL_BYTES
    ) {
      this.recordRejectedOutput();
      return;
    }
    this.queuedBytes += bytes;
    this.totalBytes += bytes;
    this.pending = this.pending.then(async () => {
      try {
        if (this.writeFailed) {
          this.recordRejectedOutput();
          return;
        }
        await this.file.writeFile(line, 'utf8');
        this.recordsWritten += 1;
      } catch {
        this.writeFailed = true;
        this.recordRejectedOutput();
      } finally {
        this.queuedBytes -= bytes;
      }
    });
  }
}
