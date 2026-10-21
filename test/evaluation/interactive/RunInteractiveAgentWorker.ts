import { createHash, randomUUID } from 'node:crypto';
import pino from 'pino';
import { setTracingDisabled } from '@openai/agents';
import { z } from 'zod';
import type { AgentResult } from '../../../src/contracts/AgentSession.js';
import {
  CompanionHudPhase,
  CompanionHudTool,
  CompanionHudAckSchema,
} from '../../../src/contracts/CompanionHud.js';
import { AgentTaskMode } from '../../../src/contracts/CursorCompanion.js';
import { TeachingLessonPhase } from '../../../src/contracts/DesktopObservation.js';
import { TeachingMessageKind } from '../../../src/contracts/TeachingStep.js';
import {
  ContextCommandSchema,
  ContextFailure,
  ContextPacketSchema,
  ContextReplySchema,
  type ContextPacket,
  type ContextReply,
} from '../../../src/contracts/StudyContext.js';
import { MemoryEvidenceStatus } from '../../../src/contracts/StudyMemory.js';
import { ComputerUseTaskRunner } from '../../../src/desktop/worker/agent/ComputerUseTaskRunner.js';
import {
  TaskModelClient,
  runWithTaskModel,
} from '../../../src/desktop/worker/agent/TaskModelClient.js';
import { LoggedCuaServer } from '../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { canCallCuaTool } from '../../../src/desktop/worker/cua/CuaTeachingPolicy.js';
import type { TaskContextPort } from '../../../src/desktop/worker/context/PrepareTaskContext.js';
import { observeInteractiveModelFetch } from './ObserveInteractiveModel.js';
import {
  AgentRequestOutputKind,
  NativeToolStage,
  redactAgentRequestOutput,
  type AgentRequestOutput,
} from './AgentRequestOutput.js';
import {
  InteractiveAgentMessageKind,
  InteractiveAgentRequestSchema,
  InteractiveAgentResponseSchema,
  InteractiveAgentSettledSchema,
  type InteractiveAgentRun,
  type InteractiveAgentSettled,
  type InteractiveAgentResponse,
} from './InteractiveAgentProtocol.js';

setTracingDisabled(true);

interface AuthoredContextFixture {
  port: TaskContextPort;
  readPreparationMs(): number | null;
}

/** Provides authored history to the normal context port, without writing a real
 * owner's database. It intentionally does not benchmark capture or semantic search. */
function createAuthoredContext(historyText: string): AuthoredContextFixture {
  const sourceId = randomUUID();
  const now = new Date();
  const packet: ContextPacket = ContextPacketSchema.parse({
    generation: 0,
    sessionId: randomUUID(),
    eventRevision: historyText ? 1 : 0,
    checkpoint: null,
    sources: historyText
      ? [
          {
            id: sourceId,
            resource: 'authored-interactive-evaluation-history',
            text: historyText,
            digest: createHash('sha256').update(historyText).digest('hex'),
            observedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          },
        ]
      : [],
    activity: [],
    gaps: [
      'Authored benchmark history only. Capture, database persistence, embeddings and semantic search are not evaluated by this fixture.',
    ],
    nextCursor: null,
  });
  let preparationStartedAt: number | null = null;
  let preparationMs: number | null = null;
  const reply = (value: ContextReply): Promise<ContextReply> =>
    Promise.resolve(ContextReplySchema.parse(value));
  const port: TaskContextPort = {
    scope: {
      enabled: true,
      available: true,
      generation: packet.generation,
      sessionId: packet.sessionId,
    },
    request: (input) => {
      const command = ContextCommandSchema.parse(input);
      preparationStartedAt ??= performance.now();
      if ('generation' in command && command.generation !== packet.generation) {
        return reply({ kind: 'failed', code: ContextFailure.STALE });
      }
      switch (command.kind) {
        case 'preferences':
          return reply({ kind: 'preferences', preference: port.scope });
        case 'resolve':
        case 'search':
        case 'inspect':
          preparationMs ??= performance.now() - preparationStartedAt;
          return reply({ kind: 'packet', packet: structuredClone(packet) });
        case 'events':
          // Task-local writes are acknowledged in memory; only authored history is exposed.
          packet.eventRevision += command.events.length;
          return reply({ kind: 'accepted', revision: packet.eventRevision });
        case 'read-source': {
          const source = packet.sources.find((item) => item.id === command.sourceId);
          if (!source) {
            return reply({ kind: 'failed', code: ContextFailure.MISSING });
          }
          const end = Math.min(source.text.length, command.offset + command.length);
          return reply({
            kind: 'source',
            sourceId: source.id,
            text: source.text.slice(command.offset, end),
            nextOffset: end < source.text.length ? end : null,
          });
        }
        case 'checkpoint': {
          if (command.update.expectedRevision !== (packet.checkpoint?.revision ?? 0)) {
            return reply({ kind: 'failed', code: ContextFailure.REVISION_CONFLICT });
          }
          if (
            command.update.coveredEventRevision > packet.eventRevision ||
            command.update.sourceIds.some(
              (id) => !packet.sources.some((source) => source.id === id),
            )
          ) {
            return reply({ kind: 'failed', code: ContextFailure.INVALID });
          }
          const revision = (packet.checkpoint?.revision ?? 0) + 1;
          packet.checkpoint = {
            ...command.update,
            claims: command.update.claims.map((claim) => ({
              ...claim,
              status: MemoryEvidenceStatus.MODEL_INFERRED,
            })),
            revision,
          };
          return reply({ kind: 'accepted', revision });
        }
        default:
          return reply({ kind: 'failed', code: ContextFailure.UNAVAILABLE });
      }
    },
  };
  return { port, readPreparationMs: () => preparationMs };
}

/** Runs the production computer-use runner and native tools in this utility worker.
 * The parent must supply a dedicated desktop/VM; this composition adds no OS boundary. */
export async function runInteractiveAgentTrial(
  command: InteractiveAgentRun,
  signal: AbortSignal,
  emit: (message: InteractiveAgentResponse) => void,
): Promise<InteractiveAgentSettled> {
  const startedAt = performance.now();
  const observedModel = observeInteractiveModelFetch();
  let toolCalls = 0;
  let mutationCalls = 0;
  let studentInputCalls = 0;
  let outputCount = 0;
  const recordOutput = (output: AgentRequestOutput): void => {
    outputCount += 1;
    emit({
      kind: InteractiveAgentMessageKind.OUTPUT,
      trialId: command.trialId,
      sequence: outputCount,
      elapsedMs: performance.now() - startedAt,
      output: redactAgentRequestOutput(output, command.credential.token),
    });
  };
  const logEventSchema = z.object({
    msg: z.enum(['cua.request', 'cua.response', 'cua.failed']),
    toolName: z.string().min(1).max(256),
    callId: z.string().max(256).optional(),
    isMutation: z.boolean().optional(),
    durationMs: z.number().nonnegative().optional(),
    isError: z.boolean().optional(),
  });
  const log = pino(
    { level: 'debug', base: null },
    {
      write(line: string): void {
        try {
          const raw: unknown = JSON.parse(line);
          const parsed = logEventSchema.safeParse(raw);
          if (!parsed.success) {
            return;
          }
          const entry = parsed.data;
          const isMutation = entry.isMutation ?? desktop.taskEvidence.isMutation(entry.toolName);
          if (entry.msg === 'cua.request') {
            toolCalls += 1;
            if (isMutation) {
              mutationCalls += 1;
              if (!canCallCuaTool(entry.toolName, AgentTaskMode.TEACH)) {
                studentInputCalls += 1;
              }
            }
          }
          recordOutput({
            kind: AgentRequestOutputKind.NATIVE_TOOL,
            stage:
              entry.msg === 'cua.request'
                ? NativeToolStage.REQUEST
                : entry.msg === 'cua.response'
                  ? NativeToolStage.RESPONSE
                  : NativeToolStage.FAILED,
            callId: entry.callId ?? null,
            toolName: entry.toolName,
            isMutation,
            durationMs: entry.durationMs ?? null,
            isError: entry.isError ?? null,
          });
        } catch {
          // Only allowlisted metadata crosses this boundary; no native arguments/results.
        }
      },
    },
  );
  const desktop = new LoggedCuaServer(
    {
      name: 'Interactive evaluation native connection',
      ...command.desktopDriver,
      cacheToolsList: true,
    },
    log,
  );
  const model = new TaskModelClient(
    command.credential.token,
    command.gatewayBaseUrl,
    observedModel.fetch,
  );
  const context = command.contextEnabled ? createAuthoredContext(command.historyText) : null;
  let runner: ComputerUseTaskRunner | null = null;
  let result: AgentResult | null = null;
  let failed: boolean;
  const onAbort = (): void => {
    void desktop.close().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const publishedSteps = new Set<string>();
  try {
    signal.throwIfAborted();
    if (Date.parse(command.credential.expiresAt) <= Date.now()) {
      throw new Error('The scoped benchmark model credential has expired.');
    }
    await desktop.connect();
    signal.throwIfAborted();
    const tools = await desktop.listTools();
    if (!tools.length) {
      throw new Error('The native desktop tools are unavailable.');
    }
    if (command.taskMode === AgentTaskMode.TEACH) {
      const group = randomUUID();
      desktop.setHudGroup(group);
      const initialHud = await desktop.callHostTool(CompanionHudTool.SET_STATE, {
        group,
        sequence: 0,
        phase: CompanionHudPhase.THINKING,
        locale: command.locale,
        level: 0,
      });
      const boundHud = await desktop.callHostTool(CompanionHudTool.BIND_CURSOR, { group });
      if (
        initialHud.isError ||
        boundHud.isError ||
        !CompanionHudAckSchema.parse(initialHud.structuredContent).applied ||
        !CompanionHudAckSchema.parse(boundHud.structuredContent).applied
      ) {
        throw new Error('The native teaching HUD could not be bound.');
      }
    }
    runner = new ComputerUseTaskRunner(desktop, log);
    result = await runWithTaskModel(model, () => {
      const activeRunner = runner;
      if (!activeRunner) {
        throw new Error('The production runner is unavailable.');
      }
      return activeRunner.runTask(
        command.request,
        command.locale,
        signal,
        command.taskMode,
        (phase) => {
          recordOutput({ kind: AgentRequestOutputKind.PROGRESS, phase });
        },
        (
          _instruction,
          phase,
          _lessonId,
          message,
          _locale,
          presentationPending,
          presentationRevoked,
        ) => {
          if (
            command.taskMode === AgentTaskMode.TEACH &&
            phase === TeachingLessonPhase.WAITING &&
            message?.kind === TeachingMessageKind.INSTRUCTION &&
            !presentationPending &&
            !presentationRevoked &&
            !publishedSteps.has(message.stepId)
          ) {
            publishedSteps.add(message.stepId);
            emit({
              kind: InteractiveAgentMessageKind.CUE_INSTALLED,
              trialId: command.trialId,
              elapsedMs: performance.now() - startedAt,
            });
          }
        },
        undefined,
        context?.port,
        (observation) => {
          recordOutput({ kind: AgentRequestOutputKind.TEACHING, observation });
        },
      );
    });
    failed = result.kind === 'failed' || signal.aborted;
  } catch {
    failed = true;
  } finally {
    signal.removeEventListener('abort', onAbort);
    model.dispose();
    try {
      if (runner) {
        await runner.close();
      } else {
        await desktop.close();
      }
    } catch {
      failed = true;
    }
  }
  const answer =
    result?.kind === 'completed'
      ? result.answer
      : result?.kind === 'teaching' && 'answer' in result.result
        ? (result.result.answer ?? null)
        : null;
  recordOutput({
    kind: AgentRequestOutputKind.FINAL,
    resultKind: result?.kind ?? null,
    answer: answer?.slice(0, 32_000) ?? null,
    answerTruncated: (answer?.length ?? 0) > 32_000,
    failed,
  });
  return InteractiveAgentSettledSchema.parse({
    kind: InteractiveAgentMessageKind.SETTLED,
    trialId: command.trialId,
    result,
    failed,
    durationMs: performance.now() - startedAt,
    contextPreparationMs: context?.readPreparationMs() ?? null,
    modelRequests: observedModel.readRequests(),
    toolCalls,
    mutationCalls,
    studentInputCalls,
    outputCount,
  });
}

const parentPort = process.parentPort;
let active: { trialId: string; abort: AbortController } | null = null;
parentPort.on('message', (event) => {
  const parsed = InteractiveAgentRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    return;
  }
  const command = parsed.data;
  if (command.kind === InteractiveAgentMessageKind.CANCEL) {
    if (active?.trialId === command.trialId) {
      active.abort.abort();
    }
    return;
  }
  if (active) {
    parentPort.postMessage(
      InteractiveAgentSettledSchema.parse({
        kind: InteractiveAgentMessageKind.SETTLED,
        trialId: command.trialId,
        result: null,
        failed: true,
        durationMs: 0,
        contextPreparationMs: null,
        modelRequests: [],
        toolCalls: 0,
        mutationCalls: 0,
      }),
    );
    return;
  }
  const abort = new AbortController();
  active = { trialId: command.trialId, abort };
  const emit = (message: InteractiveAgentResponse): void => {
    parentPort.postMessage(InteractiveAgentResponseSchema.parse(message));
  };
  void runInteractiveAgentTrial(command, abort.signal, emit)
    .then(emit)
    .catch(() => {
      // Uncertain cleanup must be retired by the parent; no raw error escapes.
      parentPort.postMessage(
        InteractiveAgentSettledSchema.parse({
          kind: InteractiveAgentMessageKind.SETTLED,
          trialId: command.trialId,
          result: null,
          failed: true,
          durationMs: 0,
          contextPreparationMs: null,
          modelRequests: [],
          toolCalls: 0,
          mutationCalls: 0,
        }),
      );
    })
    .finally(() => {
      if (active?.trialId === command.trialId) {
        active = null;
      }
    });
});
