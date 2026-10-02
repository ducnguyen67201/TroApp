import {
  AgentProgressPhase,
  type AgentProgressPhase as ProgressPhase,
} from '#contracts/CompanionHud.js';
import { z } from 'zod';
import { MCPServerStdio, type CallToolResult, type MCPCallToolOptions } from '@openai/agents';
import type { Logger } from 'pino';
import {
  CursorCompanionStateSchema,
  CursorCompanionTool,
  AgentTaskMode,
  CursorGuidanceRequestHeaderSchema,
  GuidanceReason,
} from '#contracts/CursorCompanion.js';
import { canCallCuaTool, isCursorPresentationTool } from './CuaTeachingPolicy.js';
import { CuaTaskEvidence, type GuidanceRequest } from './CuaTaskEvidence.js';

type CuaTool = Awaited<ReturnType<MCPServerStdio['listTools']>>[number];

function isReadOnlyCuaTool(tool: CuaTool): boolean {
  const annotations: unknown = 'annotations' in tool ? tool.annotations : undefined;
  return (
    typeof annotations === 'object' &&
    annotations !== null &&
    'readOnlyHint' in annotations &&
    annotations.readOnlyHint === true
  );
}

/** Keep Cua's open argument schema while avoiding an SDK strict-conversion attempt.
 * With strict conversion disabled, the Agents SDK emits the same non-strict
 * schema with additionalProperties: true for this tool either way. Its current
 * converter otherwise tries strict mode first and warns on every model turn. */
export function prepareCuaToolForAgent(tool: CuaTool): CuaTool {
  if (!tool.inputSchema.additionalProperties) {
    return tool;
  }

  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      additionalProperties: false,
    },
  };
}

function describeArgumentValue(value: unknown): { type: string; length?: number } {
  if (typeof value === 'string') {
    return { type: 'string', length: value.length };
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  return { type: value === null ? 'null' : typeof value };
}

/** Preserve argument names and types while excluding values such as typed passwords. */
export function describeCuaArguments(
  args: Record<string, unknown> | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (args === null) {
    return fields;
  }
  for (const [name, value] of Object.entries(args)) {
    fields[name] = describeArgumentValue(value);
  }
  return fields;
}

/** MCP results can contain screen images and page text, so report content kinds only. */
export function describeCuaResult(value: unknown): {
  isError: boolean;
  contentTypes: string[];
  textChars: number;
  hasStructuredContent: boolean;
  code?: string;
  status?: string;
} {
  const result = typeof value === 'object' && value !== null ? value : {};
  const content: unknown = 'content' in result ? result.content : null;
  const structured: unknown = 'structuredContent' in result ? result.structuredContent : null;
  const details = typeof structured === 'object' && structured !== null ? structured : {};
  const code = 'code' in details && typeof details.code === 'string' ? details.code : null;
  const status = 'status' in details && typeof details.status === 'string' ? details.status : null;
  const items: unknown[] = Array.isArray(content) ? content : [];
  const contentTypes: string[] = [];
  let textChars = 0;

  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('type' in item)) {
      continue;
    }
    if (typeof item.type === 'string') {
      contentTypes.push(item.type);
    }
    if ('text' in item && typeof item.text === 'string') {
      textChars += item.text.length;
    }
  }

  return {
    isError: 'isError' in result && result.isError === true,
    contentTypes,
    textChars,
    hasStructuredContent: 'structuredContent' in result && result.structuredContent !== undefined,
    ...(code !== null && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? { code } : {}),
    ...(status !== null && /^(satisfied|unsatisfied|unknown|refused)$/.test(status)
      ? { status }
      : {}),
  };
}

function validatePreviewResult(toolName: string, result: CallToolResult): CallToolResult {
  if (toolName !== CursorCompanionTool.SHOW_SEQUENCE || result.isError) {
    return result;
  }
  const state = CursorCompanionStateSchema.safeParse(result.structuredContent);
  return state.success && state.data.status === 'completed'
    ? result
    : {
        isError: true,
        content: [{ type: 'text', text: 'Cua did not acknowledge completed visual playback.' }],
      };
}

/** The SDK's default MCP path sends content only. Cua puts targeting IDs and
 * capture geometry in structuredContent, so include it alongside the image.
 * The SDK's structured-only option would discard screenshot content.
 */
function includeCuaMetadata(result: CallToolResult): CallToolResult {
  if (result.structuredContent === undefined) {
    return result;
  }
  return {
    ...result,
    content: [...result.content, { type: 'text', text: JSON.stringify(result.structuredContent) }],
  };
}

/** Trace the real SDK-to-Cua MCP boundary; the SDK calls this method for each tool. */
export class LoggedCuaServer extends MCPServerStdio {
  readonly taskEvidence = new CuaTaskEvidence();
  private activeToolCount = 0;
  private receiveProgress: ((phase: ProgressPhase) => void) | null = null;

  setProgressListener(listener: ((phase: ProgressPhase) => void) | null): void {
    this.receiveProgress = listener;
  }
  private taskMode: AgentTaskMode = AgentTaskMode.EXECUTE;
  private discoveredTools: Set<string> | null = null;
  private onTeachingTerminal: (() => void) | null = null;

  setTaskMode(mode: AgentTaskMode): void {
    this.taskMode = mode;
  }

  beginTeachingTask(taskEpoch: string, onTerminal: () => void): void {
    this.taskMode = AgentTaskMode.TEACH;
    this.taskEvidence.beginGuidanceTask(taskEpoch);
    this.onTeachingTerminal = onTerminal;
  }

  endTeachingTask(): void {
    this.onTeachingTerminal = null;
  }

  hasCompanionTools(): boolean {
    return [
      'show_cursor_sequence',
      'set_cursor_companion_mode',
      'cancel_cursor_sequence',
      'get_cursor_companion_state',
    ].every((name) => this.discoveredTools?.has(name));
  }

  hasGuidanceTools(): boolean {
    return [
      CursorCompanionTool.READ_CAPABILITIES,
      CursorCompanionTool.BEGIN_TASK,
      CursorCompanionTool.END_TASK,
    ].every((name) => this.discoveredTools?.has(name));
  }

  /** Trusted worker lifecycle operations; never advertised to the model. */
  callHostTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return super.callToolResult(toolName, args);
  }

  constructor(
    options: ConstructorParameters<typeof MCPServerStdio>[0],
    private readonly log: Logger,
  ) {
    super(options);
  }

  override async listTools(): ReturnType<MCPServerStdio['listTools']> {
    const tools = await super.listTools();
    this.discoveredTools = new Set(tools.map((tool) => tool.name));
    /* Cua owns action classification; a write needs a fresh state observation. */
    this.taskEvidence.setToolsRequiringObservation(
      tools
        .filter((tool) => !isReadOnlyCuaTool(tool) && !isCursorPresentationTool(tool.name))
        .map((tool) => tool.name),
    );
    return tools
      .filter((tool) => canCallCuaTool(tool.name, this.taskMode))
      .map((tool) => {
        const required = z.array(z.string()).default([]).parse(tool.inputSchema.required);
        const properties = { ...tool.inputSchema.properties };
        delete properties.session;
        delete properties.cursor_id;
        delete properties.task_epoch;
        delete properties.sequence_id;
        const guided =
          this.taskMode === AgentTaskMode.TEACH && tool.name === CursorCompanionTool.SHOW_SEQUENCE;
        return prepareCuaToolForAgent({
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: guided
              ? { ...properties, presentation_version: { type: 'integer', const: 2 } }
              : properties,
            required: [
              ...new Set([
                ...required.filter(
                  (name) => !['session', 'cursor_id', 'task_epoch', 'sequence_id'].includes(name),
                ),
                ...(guided ? ['presentation_version'] : []),
              ]),
            ],
          },
        });
      });
  }

  override async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    let guidanceRequest: GuidanceRequest | null = null;
    if (
      !canCallCuaTool(toolName, this.taskMode) ||
      (this.taskMode === AgentTaskMode.TEACH && this.taskEvidence.hasTerminalGuidance()) ||
      (this.taskMode === AgentTaskMode.TEACH && this.taskEvidence.hasPendingGuidance()) ||
      (args !== null &&
        (Object.hasOwn(args, 'session') ||
          Object.hasOwn(args, 'cursor_id') ||
          Object.hasOwn(args, 'task_epoch') ||
          Object.hasOwn(args, 'sequence_id') ||
          Object.keys(args).some((name) => name.startsWith('_'))))
    ) {
      const result: CallToolResult = {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'This tool or session override is unavailable in the current task mode.',
          },
        ],
      };
      this.taskEvidence.record(toolName, result);
      if (this.taskMode === AgentTaskMode.TEACH) {
        this.taskEvidence.failGuidance(GuidanceReason.INVALID_REQUEST);
        this.onTeachingTerminal?.();
      }
      return includeCuaMetadata(result);
    }
    if (this.taskMode === AgentTaskMode.TEACH && toolName === CursorCompanionTool.SHOW_SEQUENCE) {
      const parsed = CursorGuidanceRequestHeaderSchema.safeParse(args);
      if (parsed.success) {
        guidanceRequest = this.taskEvidence.beginGuidanceRequest(parsed.data.steps.length);
      }
      if (!guidanceRequest) {
        this.taskEvidence.failGuidance(GuidanceReason.INVALID_REQUEST);
        this.onTeachingTerminal?.();
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'A live V2 guidance task and explicit presentation_version: 2 are required.',
            },
          ],
        };
      }
    }

    const startedAt = performance.now();
    this.log.debug({ toolName, arguments: describeCuaArguments(args) }, 'cua.request');
    try {
      const native = await this.callTaskTool(toolName, args, meta, options);
      let result = guidanceRequest ? native : validatePreviewResult(toolName, native);
      if (guidanceRequest) {
        const valid = this.taskEvidence.settleGuidanceRequest(guidanceRequest, result);
        if (!valid && !result.isError) {
          result = {
            isError: true,
            content: [
              { type: 'text', text: 'Cua did not acknowledge this task’s completed visual guide.' },
            ],
          };
        }
      } else {
        this.taskEvidence.record(toolName, result);
        if (
          this.taskMode === AgentTaskMode.TEACH &&
          toolName === CursorCompanionTool.CANCEL_SEQUENCE &&
          !result.isError
        ) {
          this.taskEvidence.cancelGuidance(GuidanceReason.EXPLICIT_STOP);
        }
        if (this.taskMode === AgentTaskMode.TEACH && result.isError) {
          this.taskEvidence.failGuidance(GuidanceReason.TRANSPORT_FAILED);
        }
      }
      if (this.taskEvidence.hasTerminalGuidance()) {
        this.onTeachingTerminal?.();
      }
      this.log.debug(
        {
          toolName,
          durationMs: Math.round(performance.now() - startedAt),
          ...describeCuaResult(result),
        },
        'cua.response',
      );
      return includeCuaMetadata(result);
    } catch (error) {
      if (this.taskMode === AgentTaskMode.TEACH) {
        this.taskEvidence.failGuidance(GuidanceReason.TRANSPORT_FAILED);
        this.onTeachingTerminal?.();
      }
      this.log.debug(
        {
          toolName,
          errorType: error instanceof Error ? error.name : typeof error,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'cua.failed',
      );
      throw error;
    }
  }
  private async callTaskTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    this.activeToolCount += 1;
    this.receiveProgress?.(
      this.taskMode === AgentTaskMode.TEACH
        ? AgentProgressPhase.SHOWING
        : AgentProgressPhase.WORKING,
    );
    try {
      return await super.callToolResult(toolName, args, meta, options);
    } finally {
      this.activeToolCount -= 1;
      if (this.activeToolCount === 0) {
        this.receiveProgress?.(AgentProgressPhase.THINKING);
      }
    }
  }
}
