import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import OpenAI from 'openai';
import type { FunctionTool, ResponseInputItem } from 'openai/resources/responses/responses';
import { z } from 'zod';
import {
  LessonEvidenceKind,
  LessonPhase,
  RenderManifestSchema,
  type LearnerProjection,
  type RenderManifest,
} from '#contracts/GuidedLessons.js';
import { hashLessonValue } from '../application/BuildLessonInput.js';
import { LessonPolicy } from '../application/LessonBudget.js';
import {
  LessonArtifactKind,
  LessonProviderNotDispatchedError,
  type LessonMediaArtifact,
  type LessonRenderer,
  type LessonRenderLifecycle,
} from '../application/LessonPorts.js';
import { buildLessonProjection } from '../domain/BuildLessonProjection.js';
import { buildLessonTimeline } from './BuildLessonTimeline.js';
import type {
  LessonCodePreview,
  LessonCodeRequest,
  LessonCodeSandbox,
} from './LessonCodeSandbox.js';
import { LessonCodeLimits, LessonCodeSandboxError } from './LessonCodeSandbox.js';
import {
  LessonPresentationIdentitySchema,
  LessonRenderInputSchema,
  LessonRenderResultSchema,
  type LessonPresentationIdentity,
} from './LessonRenderProtocol.js';
import { readLessonGeometryIssues } from './LessonGeometryDiagnostics.js';
import { RemotionAgentPrompt, RemotionAgentPromptVersion } from './RemotionAgentPrompts.js';
import { createRemotionModelFetch } from './RemotionModelFetch.js';
import {
  readRemotionProviderFailure,
  type RemotionProviderFailure,
} from './RemotionProviderFailure.js';

const MaximumModelTurns = 12;
const MaximumArtifactBytes = 16 * 1024 * 1024;
const MaximumRunBytes = 160 * 1024 * 1024;
const WriteSceneSchema = z.strictObject({
  source: z.string().min(1).max(LessonCodeLimits.SOURCE_BYTES),
});
const PreviewArgumentsSchema = z.strictObject({
  frames: z.array(z.number().int().min(0).max(8999)).min(1).max(4),
});
const VideoArgumentsSchema = z.strictObject({});
const FinalResultSchema = z.strictObject({
  status: z.literal('ready'),
  summary: z.string().min(1).max(1000),
});
const ResponseStatusSchema = z.enum(['completed', 'in_progress', 'incomplete']);
const FunctionCallSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  arguments: z.string().max(400_000),
  id: z.string().optional(),
  status: ResponseStatusSchema.optional(),
});
const ReasoningSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string(),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })),
  encrypted_content: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.literal('reasoning_text'), text: z.string() })).optional(),
  status: ResponseStatusSchema.optional(),
});
const MessageSchema = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('output_text'), text: z.string() }),
      z.object({ type: z.literal('refusal'), refusal: z.string() }),
    ]),
  ),
});
const ResponseEnvelopeSchema = z.object({
  id: z.string(),
  status: z.string(),
  output: z
    .array(z.discriminatedUnion('type', [FunctionCallSchema, ReasoningSchema, MessageSchema]))
    .max(16),
});
const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  input_tokens_details: z
    .object({
      cached_tokens: z.number().int().nonnegative().optional(),
      cache_write_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});
const UsageEnvelopeSchema = z.object({
  usage: UsageSchema.nullable().optional(),
  _request_id: z.string().nullable().optional(),
});
const RequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,256}$/)
  .nullable();

const Tools: FunctionTool[] = [
  {
    type: 'function',
    name: 'write_scene',
    description: 'Replace the current scene TSX module. Invalidates prior preview and video.',
    strict: true,
    parameters: z.toJSONSchema(WriteSceneSchema),
  },
  {
    type: 'function',
    name: 'render_preview',
    description: 'Compile and render up to 4 current-source PNGs and measured text geometry.',
    strict: true,
    parameters: z.toJSONSchema(PreviewArgumentsSchema),
  },
  {
    type: 'function',
    name: 'render_video',
    description: 'Encode silent MP4 after inspecting a successful current-source preview.',
    strict: true,
    parameters: z.toJSONSchema(VideoArgumentsSchema),
  },
];

export type RemotionAgentMeasurement =
  | {
      kind: 'model';
      stage: 'remotionCoding';
      sceneId: string;
      phase: LessonPhase;
      attemptId: string;
      model: string;
      requestId: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      cacheWriteInputTokens: number | null;
      reasoningOutputTokens: number | null;
      wallTimeMs: number;
      status: 'completed' | 'uncertain' | 'invalid';
      failure: RemotionProviderFailure | null;
    }
  | {
      kind: 'tool';
      stage: 'remotionCoding';
      sceneId: string;
      phase: LessonPhase;
      tool: 'write_scene' | 'render_preview' | 'render_video';
      wallTimeMs: number;
      successful: boolean;
      sourceDigest: string | null;
    };

export interface RemotionLessonAgentOptions {
  fetch?: typeof fetch;
  bundlePath?: string;
  identity?: LessonPresentationIdentity;
  onMeasurement?: (measurement: RemotionAgentMeasurement) => void;
}

interface SceneState {
  source: string | null;
  sourceDigest: string | null;
  preview: LessonCodePreview | null;
  previewDigest: string | null;
  qualityIssues: { frame: number; message: string }[];
  deliveredDigest: string | null;
  inspectedDigest: string | null;
  video: Uint8Array | null;
  videoDigest: string | null;
}

/** A real coding/tool loop. Generated TSX is accepted only by the isolated sandbox, never executed in this process. */
export class RemotionLessonAgent implements LessonRenderer {
  private readonly client: OpenAI | null;
  private active = false;
  readonly version: string;

  constructor(
    apiKey: string | undefined,
    private readonly model: string,
    private readonly sandbox: LessonCodeSandbox,
    private readonly options: RemotionLessonAgentOptions = {},
  ) {
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          maxRetries: 0,
          timeout: 180_000,
          fetch: options.fetch ?? createRemotionModelFetch(),
        })
      : null;
    this.version = `${model}:${RemotionAgentPromptVersion}`;
  }

  /** Check local prerequisites before spending on authoring or reserving a graphics request. */
  async checkReady(signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      if (!this.client) {
        throw new Error('No model provider.');
      }
      await this.readIdentity();
      await this.sandbox.checkReady?.(signal);
      signal.throwIfAborted();
    } catch {
      throw new LessonProviderNotDispatchedError(
        'Guided lesson generation requires a configured model provider and a ready isolated render sandbox.',
      );
    }
  }

  async render(
    request: Parameters<LessonRenderer['render']>[0],
    signal: AbortSignal,
    lifecycle?: LessonRenderLifecycle,
  ): ReturnType<LessonRenderer['render']> {
    if (!this.client) {
      throw new LessonProviderNotDispatchedError(
        'Guided lesson graphics require a configured model provider.',
      );
    }
    if (this.active || signal.aborted) {
      throw new Error('The Remotion coding agent is busy or cancelled.');
    }
    this.active = true;
    const renderSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(LessonPolicy.GRAPHICS_DEADLINE_MS),
    ]);
    try {
      const validated = LessonRenderInputSchema.parse(request);
      let mediaBytes = validated.speechArtifacts.reduce(
        (total, artifact) => total + artifact.bytes.byteLength,
        0,
      );
      if (mediaBytes > MaximumRunBytes) {
        throw new Error('Lesson media exceeds the run allowance.');
      }
      const identity = await this.readIdentity();
      let manifest = buildLessonTimeline(validated, {
        compositionBundleHash: identity.compositionBundleHash,
        fontBundleHash: identity.fontBundleHash,
        rendererVersion: identity.rendererVersion,
      });
      const artifacts: LessonMediaArtifact[] = [];
      const progress = {
        version: 0,
        sceneId: validated.plan.scenes[0]?.sceneId ?? '',
        revealed: validated.plan.checkpoints.map((checkpoint) => checkpoint.checkpointId),
        attempted: [],
        independent: [],
        hinted: [],
        frame: 0,
      };
      for (const scene of validated.plan.scenes) {
        const checkpoint = validated.plan.checkpoints.find(
          (item) => item.sceneId === scene.sceneId,
        );
        const phases = checkpoint ? [checkpoint.phase, LessonPhase.WORKED] : [LessonPhase.WATCH];
        for (const phase of phases) {
          renderSignal.throwIfAborted();
          const projection = buildLessonProjection({
            record: { ...validated, releaseId: 'teacher-preview', manifest },
            progress,
            sceneId: scene.sceneId,
            teacherPreview: true,
            phase,
            hashValue: hashLessonValue,
          });
          const generated = await this.generateScene(projection, renderSignal, lifecycle);
          for (const artifact of generated.artifacts) {
            mediaBytes += artifact.bytes.byteLength;
            if (mediaBytes > MaximumRunBytes) {
              throw new Error('Lesson media exceeds the run allowance.');
            }
          }
          artifacts.push(...generated.artifacts);
          manifest = { ...manifest, evidence: [...manifest.evidence, ...generated.evidence] };
        }
      }
      return LessonRenderResultSchema.parse({
        manifest: RenderManifestSchema.parse(manifest),
        artifacts,
      });
    } finally {
      this.active = false;
    }
  }

  private async readIdentity(): Promise<LessonPresentationIdentity> {
    if (this.options.identity) {
      return LessonPresentationIdentitySchema.parse(this.options.identity);
    }
    const raw: unknown = JSON.parse(
      await readFile(
        join(this.options.bundlePath ?? resolve('dist/lessonBundle'), 'PresentationIdentity.json'),
        'utf8',
      ),
    );
    return LessonPresentationIdentitySchema.parse(raw);
  }

  private async generateScene(
    projection: LearnerProjection,
    signal: AbortSignal,
    lifecycle: LessonRenderLifecycle | undefined,
  ): Promise<{ artifacts: LessonMediaArtifact[]; evidence: RenderManifest['evidence'] }> {
    const durationInFrames = readProjectionEnd(projection);
    const state: SceneState = {
      source: null,
      sourceDigest: null,
      preview: null,
      previewDigest: null,
      qualityIssues: [],
      deliveredDigest: null,
      inspectedDigest: null,
      video: null,
      videoDigest: null,
    };
    const history: ResponseInputItem[] = [
      {
        role: 'user',
        content: JSON.stringify({
          durationInFrames,
          projection,
          suggestedPreviewFrames: readSuggestedFrames(projection, durationInFrames),
        }),
      },
    ];
    for (let turn = 0; turn < MaximumModelTurns; turn += 1) {
      signal.throwIfAborted();
      const response = await this.callModel(history, projection, signal, lifecycle);
      /* The next successful model response has received the actual current-source images. */
      if (state.deliveredDigest === state.sourceDigest && state.deliveredDigest !== null) {
        state.inspectedDigest = state.deliveredDigest;
      }
      removeInspectedImages(history);
      const calls = response.output.filter((item) => item.type === 'function_call');
      for (const item of response.output) {
        if (item.type === 'message') {
          const text = item.content
            .map((part) => (part.type === 'output_text' ? part.text : part.refusal))
            .join('\n');
          history.push({ role: 'assistant', content: text });
        } else if (item.type === 'reasoning') {
          history.push({
            type: item.type,
            id: item.id,
            summary: item.summary,
            ...(item.encrypted_content !== undefined
              ? { encrypted_content: item.encrypted_content }
              : {}),
            ...(item.content !== undefined ? { content: item.content } : {}),
          });
        } else {
          history.push({
            type: item.type,
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments,
            ...(item.id !== undefined ? { id: item.id } : {}),
          });
        }
      }
      if (calls.length === 0) {
        const text = response.output
          .flatMap((item) =>
            item.type === 'message'
              ? item.content.flatMap((part) => (part.type === 'output_text' ? [part.text] : []))
              : [],
          )
          .join('');
        const raw: unknown = JSON.parse(text);
        FinalResultSchema.parse(raw);
        return buildSceneArtifacts(state, projection);
      }
      for (const call of calls) {
        signal.throwIfAborted();
        history.push(await this.executeTool(call, state, projection, durationInFrames, signal));
      }
    }
    throw new Error('The Remotion coding agent reached its execution turn limit.');
  }

  private async callModel(
    history: ResponseInputItem[],
    projection: LearnerProjection,
    signal: AbortSignal,
    lifecycle: LessonRenderLifecycle | undefined,
  ): Promise<z.infer<typeof ResponseEnvelopeSchema>> {
    if (!this.client) {
      throw new LessonProviderNotDispatchedError();
    }
    const attemptId = randomUUID();
    await lifecycle?.beforeModelCall(attemptId);
    const started = performance.now();
    let usage: z.infer<typeof UsageSchema> | null = null;
    let requestId: string | null = null;
    let failure: RemotionProviderFailure | null = null;
    let providerResponded = false;
    let status: 'completed' | 'uncertain' | 'invalid' = 'uncertain';
    try {
      const raw: unknown = await this.client.responses.create(
        {
          model: this.model,
          instructions: RemotionAgentPrompt,
          input: history,
          tools: Tools,
          parallel_tool_calls: false,
          store: false,
          include: ['reasoning.encrypted_content'],
          max_output_tokens: 12_000,
        },
        { signal },
      );
      providerResponded = true;
      const envelope = UsageEnvelopeSchema.safeParse(raw);
      if (envelope.success) {
        usage = envelope.data.usage ?? null;
        requestId = envelope.data._request_id ?? null;
      }
      if (!usage) {
        throw new Error('The Remotion coding model returned an uncertain usage outcome.');
      }
      status = 'invalid';
      const response = ResponseEnvelopeSchema.parse(raw);
      if (response.status !== 'completed') {
        throw new Error('The Remotion coding model did not complete its response.');
      }
      status = 'completed';
      return response;
    } catch (error) {
      failure = readRemotionProviderFailure(error, signal, providerResponded);
      if (error instanceof OpenAI.APIError) {
        const parsed = RequestIdSchema.safeParse(error.requestID);
        if (parsed.success) {
          requestId = parsed.data;
        }
      }
      throw error;
    } finally {
      try {
        await lifecycle?.afterModelCall(
          attemptId,
          usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null,
        );
      } finally {
        this.observe({
          kind: 'model',
          stage: 'remotionCoding',
          sceneId: projection.sceneId,
          phase: projection.phase,
          attemptId,
          model: this.model,
          requestId,
          inputTokens: usage?.input_tokens ?? null,
          outputTokens: usage?.output_tokens ?? null,
          cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
          cacheWriteInputTokens: usage?.input_tokens_details?.cache_write_tokens ?? null,
          reasoningOutputTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
          wallTimeMs: performance.now() - started,
          status,
          failure,
        });
      }
    }
  }

  private async executeTool(
    call: z.infer<typeof FunctionCallSchema>,
    state: SceneState,
    projection: LearnerProjection,
    durationInFrames: number,
    signal: AbortSignal,
  ): Promise<ResponseInputItem> {
    const started = performance.now();
    let successful = false;
    try {
      const raw: unknown = JSON.parse(call.arguments);
      if (call.name === 'write_scene') {
        const { source } = WriteSceneSchema.parse(raw);
        if (new TextEncoder().encode(source).byteLength > LessonCodeLimits.SOURCE_BYTES) {
          return toolText(call.call_id, { error: 'Source exceeds the UTF-8 byte limit.' });
        }
        state.source = source;
        state.sourceDigest = hashBytes(Buffer.from(source));
        state.preview = null;
        state.previewDigest = null;
        state.qualityIssues = [];
        state.deliveredDigest = null;
        state.inspectedDigest = null;
        state.video = null;
        state.videoDigest = null;
        successful = true;
        return toolText(call.call_id, { saved: true, sourceDigest: state.sourceDigest });
      }
      if (!state.source || !state.sourceDigest) {
        return toolText(call.call_id, { error: 'Call write_scene before rendering.' });
      }
      const request: LessonCodeRequest = { source: state.source, projection, durationInFrames };
      if (call.name === 'render_preview') {
        const { frames } = PreviewArgumentsSchema.parse(raw);
        if (
          new Set(frames).size !== frames.length ||
          frames.some((frame) => frame >= durationInFrames)
        ) {
          return toolText(call.call_id, {
            error: 'Choose distinct frames within durationInFrames.',
          });
        }
        const sampledFrames = readRequiredFrames(projection, durationInFrames, frames);
        const preview = await this.sandbox.preview(request, sampledFrames, signal);
        if (
          preview.frames.length !== sampledFrames.length ||
          new Set(preview.frames.map((frame) => frame.frame)).size !== sampledFrames.length ||
          preview.frames.reduce((total, frame) => total + frame.bytes.byteLength, 0) >
            MaximumArtifactBytes ||
          preview.frames.some(
            (frame) =>
              !sampledFrames.includes(frame.frame) ||
              frame.bytes.byteLength === 0 ||
              frame.bytes.byteLength > MaximumArtifactBytes,
          )
        ) {
          throw new Error('Incomplete preview.');
        }
        state.preview = preview;
        state.previewDigest = state.sourceDigest;
        state.qualityIssues = preview.frames.flatMap(({ frame, geometry }) =>
          readLessonGeometryIssues(geometry).map((message) => ({ frame, message })),
        );
        state.deliveredDigest = state.sourceDigest;
        state.inspectedDigest = null;
        state.video = null;
        state.videoDigest = null;
        successful = state.qualityIssues.length === 0;
        return {
          type: 'function_call_output',
          call_id: call.call_id,
          output: [
            {
              type: 'input_text',
              text: JSON.stringify({
                sourceDigest: state.sourceDigest,
                measurements: preview.frames.map(({ frame, geometry }) => ({ frame, geometry })),
                qualityIssues: state.qualityIssues,
                videoAllowed: state.qualityIssues.length === 0,
                instruction:
                  state.qualityIssues.length === 0
                    ? 'Inspect these actual images before encoding the current source.'
                    : 'Inspect these actual images and repair every listed layout issue. Encoding is blocked until a new preview passes.',
              }),
            },
            ...preview.frames.flatMap((frame) => [
              { type: 'input_text' as const, text: `Actual preview frame: ${String(frame.frame)}` },
              {
                type: 'input_image' as const,
                image_url: `data:image/png;base64,${Buffer.from(frame.bytes).toString('base64')}`,
                detail: 'high' as const,
              },
            ]),
          ],
        };
      }
      if (call.name === 'render_video') {
        VideoArgumentsSchema.parse(raw);
        if (
          !state.preview ||
          state.previewDigest !== state.sourceDigest ||
          state.inspectedDigest !== state.sourceDigest
        ) {
          return toolText(call.call_id, {
            error:
              'Render a preview of the current source and inspect it on a later model turn first.',
          });
        }
        if (state.qualityIssues.length !== 0) {
          return toolText(call.call_id, {
            error:
              'The current preview has layout quality issues. Revise the source and render a passing preview before encoding.',
            qualityIssues: state.qualityIssues,
          });
        }
        const video = await this.sandbox.renderVideo(request, signal);
        if (video.byteLength === 0 || video.byteLength > MaximumArtifactBytes) {
          throw new Error('Invalid encoded video size.');
        }
        state.video = video;
        state.videoDigest = state.sourceDigest;
        successful = true;
        return toolText(call.call_id, {
          rendered: true,
          sourceDigest: state.sourceDigest,
          videoDigest: hashBytes(video),
          byteLength: video.byteLength,
        });
      }
      return toolText(call.call_id, {
        error: 'Only write_scene, render_preview and render_video are available.',
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof LessonCodeSandboxError) {
        return toolText(call.call_id, {
          error: 'The isolated sandbox rejected the current source or render.',
          stage: error.stage,
          diagnostic: error.message,
        });
      }
      return toolText(call.call_id, {
        error:
          'Tool arguments, source validation, compilation, geometry, or rendering failed. Revise the source or request and retry explicitly.',
      });
    } finally {
      if (
        call.name === 'write_scene' ||
        call.name === 'render_preview' ||
        call.name === 'render_video'
      ) {
        this.observe({
          kind: 'tool',
          stage: 'remotionCoding',
          sceneId: projection.sceneId,
          phase: projection.phase,
          tool: call.name,
          wallTimeMs: performance.now() - started,
          successful,
          sourceDigest: state.sourceDigest,
        });
      }
    }
  }

  private observe(measurement: RemotionAgentMeasurement): void {
    try {
      this.options.onMeasurement?.(measurement);
    } catch {
      /* An optional benchmark observer cannot change generation or billing settlement. */
    }
  }
}

function toolText(callId: string, value: unknown): ResponseInputItem {
  return { type: 'function_call_output', call_id: callId, output: JSON.stringify(value) };
}

/** Keep tool IDs, text/geometry and reasoning history; old pixels have already been inspected. */
function removeInspectedImages(history: ResponseInputItem[]): void {
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index];
    if (item?.type === 'function_call_output' && typeof item.output !== 'string') {
      history[index] = {
        ...item,
        output: item.output.filter((part) => part.type !== 'input_image'),
      };
    }
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readProjectionEnd(projection: LearnerProjection): number {
  return Math.max(
    30,
    ...projection.narrationCues.map((cue) => cue.endFrame),
    ...projection.visualCues.map((cue) => cue.endFrame),
  );
}

function readSuggestedFrames(projection: LearnerProjection, duration: number): number[] {
  return [
    ...new Set([
      0,
      Math.floor(duration / 2),
      projection.visualCues.at(-1)?.startFrame ?? duration - 1,
      duration - 1,
    ]),
  ];
}

/** Sample every approved caption and visible-state interval; the model cannot omit a difficult cue. */
function readRequiredFrames(
  projection: LearnerProjection,
  duration: number,
  requested: number[],
): number[] {
  const frames = [
    ...new Set([
      0,
      duration - 1,
      ...projection.narrationCues.map((cue) => Math.floor((cue.startFrame + cue.endFrame - 1) / 2)),
      ...projection.visualCues.map((cue) => Math.floor((cue.startFrame + cue.endFrame - 1) / 2)),
      ...requested,
    ]),
  ].sort((first, second) => first - second);
  if (frames.length > LessonCodeLimits.FRAME_COUNT) {
    throw new Error('The approved scene requires too many distinct preview samples.');
  }
  return frames;
}

function buildSceneArtifacts(
  state: SceneState,
  projection: LearnerProjection,
): { artifacts: LessonMediaArtifact[]; evidence: RenderManifest['evidence'] } {
  if (
    !state.source ||
    !state.sourceDigest ||
    !state.preview ||
    state.qualityIssues.length !== 0 ||
    !state.video ||
    state.previewDigest !== state.sourceDigest ||
    state.inspectedDigest !== state.sourceDigest ||
    state.videoDigest !== state.sourceDigest
  ) {
    throw new Error(
      'The coding agent has not rendered and inspected a video for its current source.',
    );
  }
  const representative = state.preview.frames[Math.floor(state.preview.frames.length / 2)];
  if (!representative) {
    throw new Error('The coding agent has no inspected frame.');
  }
  const geometry = Buffer.from(
    JSON.stringify({
      sceneId: projection.sceneId,
      phase: projection.phase,
      frame: representative.frame,
      canvas: { width: 1920, height: 1080 },
      smallestPlayer: { width: 640, height: 360 },
      measurements: state.preview.frames.map(({ frame, geometry }) => ({ frame, geometry })),
    }),
  );
  const source = Buffer.from(
    JSON.stringify({ source: state.source, sourceDigest: state.sourceDigest }),
  );
  const entries = [
    {
      kind: LessonArtifactKind.FRAME,
      evidenceKind: LessonEvidenceKind.FRAME,
      mimeType: 'image/png',
      bytes: representative.bytes,
    },
    {
      kind: LessonArtifactKind.SOURCE,
      evidenceKind: LessonEvidenceKind.GEOMETRY,
      mimeType: 'application/json',
      bytes: geometry,
    },
    {
      kind: LessonArtifactKind.CLIP,
      evidenceKind: LessonEvidenceKind.CLIP,
      mimeType: 'video/mp4',
      bytes: state.video,
    },
    {
      kind: LessonArtifactKind.SOURCE,
      evidenceKind: LessonEvidenceKind.VALIDATION,
      mimeType: 'application/json',
      bytes: source,
    },
  ];
  const artifacts: LessonMediaArtifact[] = [];
  const evidence: RenderManifest['evidence'] = [];
  for (const entry of entries) {
    if (entry.bytes.byteLength > MaximumArtifactBytes) {
      throw new Error('Generated lesson artifact exceeds its payload limit.');
    }
    const artifactId = randomUUID();
    const digest = hashBytes(entry.bytes);
    artifacts.push({
      artifactId,
      kind: entry.kind,
      mimeType: entry.mimeType,
      bytes: entry.bytes,
      digest,
      sceneId: projection.sceneId,
      phase: projection.phase,
    });
    evidence.push({
      evidenceId: `${entry.evidenceKind}-${artifactId}`,
      artifactId,
      kind: entry.evidenceKind,
      digest,
      sceneId: projection.sceneId,
      frame: representative.frame,
      phase: projection.phase,
    });
  }
  return { artifacts, evidence };
}
