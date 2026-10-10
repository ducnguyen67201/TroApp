import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import {
  AuthorResultSchema,
  HelpResultSchema,
  ReviewResultSchema,
  RepairResultSchema,
  VisualRepairResultSchema,
} from '#contracts/GuidedLessons.js';
import {
  LessonModelStage,
  LessonProviderNotDispatchedError,
  type LessonModel,
  type LessonModelRequest,
} from '../application/LessonPorts.js';
import { hashLessonValue } from '../application/BuildLessonInput.js';
import { LessonGeometrySchema } from './LessonRenderProtocol.js';
import { LessonPrompts, LessonPromptVersion } from './LessonPrompts.js';

/** Count and dispatch share the exact system, data, image and output-schema payload. No implicit retries or runtime tools. */
export class OpenAiLessonModel implements LessonModel {
  private readonly client: OpenAI | null;
  readonly version: string;

  constructor(
    apiKey: string | undefined,
    private readonly model = 'gpt-5.4',
    request: typeof fetch = fetch,
  ) {
    this.client = apiKey
      ? new OpenAI({ apiKey, maxRetries: 0, timeout: 180_000, fetch: request })
      : null;
    this.version = `${model}:${LessonPromptVersion}`;
  }

  async countInput(request: LessonModelRequest, signal?: AbortSignal): Promise<number> {
    if (!this.client) {
      throw new LessonProviderNotDispatchedError(
        'Guided lesson generation requires a configured model provider.',
      );
    }
    const response = await this.client.responses.inputTokens.count(
      this.buildRequest(request),
      signal ? { signal } : {},
    );
    return response.input_tokens;
  }

  async generate(
    request: LessonModelRequest,
    signal: AbortSignal,
  ): ReturnType<LessonModel['generate']> {
    if (!this.client) {
      throw new LessonProviderNotDispatchedError(
        'Guided lesson generation requires a configured model provider.',
      );
    }
    const response = await this.client.responses.create(
      { ...this.buildRequest(request), store: false, max_output_tokens: request.maxOutputTokens },
      { signal },
    );
    const usage = response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : null;
    // Preserve reported usage even for refused, truncated or malformed outputs.
    // Application validation ends the run rather than launching a hidden format repair.
    if (response.status !== 'completed') {
      return { result: null, usage };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.output_text);
    } catch {
      return { result: null, usage };
    }
    const parsed = readOutputEnvelope(request.stage).safeParse(raw);
    return { result: parsed.success ? parsed.data.result : null, usage };
  }

  private buildRequest(request: LessonModelRequest) {
    const format = zodTextFormat(readOutputEnvelope(request.stage), 'tro_guided_lesson_stage');
    const images =
      request.stage === LessonModelStage.VISUAL_REVIEW
        ? request.evidence.filter((artifact) => artifact.kind === 'frame').slice(0, 12)
        : [];
    return {
      model: this.model,
      instructions: `${LessonPrompts.SHARED}\n\n${readStagePrompt(request.stage)}`,
      input: [
        {
          role: 'user' as const,
          content: [
            { type: 'input_text' as const, text: JSON.stringify(buildStageInput(request)) },
            ...images.flatMap((artifact) => [
              { type: 'input_text' as const, text: `Evidence image ID: ${artifact.artifactId}` },
              {
                type: 'input_image' as const,
                image_url: `data:${artifact.mimeType};base64,${Buffer.from(artifact.bytes).toString('base64')}`,
                detail: 'high' as const,
              },
            ]),
          ],
        },
      ],
      text: { format },
    };
  }
}

function readOutputEnvelope(stage: LessonModelStage) {
  const result =
    stage === LessonModelStage.HELP
      ? HelpResultSchema
      : stage === LessonModelStage.DRAFT
        ? AuthorResultSchema
        : stage === LessonModelStage.REPAIR
          ? RepairResultSchema
          : stage === LessonModelStage.VISUAL_REPAIR
            ? VisualRepairResultSchema
            : ReviewResultSchema;
  return z.strictObject({ result });
}

function readStagePrompt(stage: LessonModelStage): string {
  switch (stage) {
    case LessonModelStage.HELP:
      return LessonPrompts.HELP;
    case LessonModelStage.DRAFT:
      return LessonPrompts.DRAFT;
    case LessonModelStage.REVIEW:
      return LessonPrompts.REVIEW;
    case LessonModelStage.REPAIR:
      return LessonPrompts.REPAIR;
    case LessonModelStage.VISUAL_REVIEW:
      return LessonPrompts.VISUAL_REVIEW;
    case LessonModelStage.VISUAL_REPAIR:
      return LessonPrompts.VISUAL_REPAIR;
  }
}

function buildStageInput(request: LessonModelRequest): unknown {
  if (request.stage === LessonModelStage.HELP) {
    if (!request.helpContext) {
      throw new LessonProviderNotDispatchedError();
    }
    return { mode: 'groundedQuestion', ...request.helpContext };
  }
  if (request.stage === LessonModelStage.DRAFT) {
    return request.input;
  }
  const allowedIssueIds = request.review?.issues.map((issue) => issue.issueId) ?? [];
  if (request.stage === LessonModelStage.REVIEW) {
    return {
      candidateHash: request.contentHash,
      lessonInput: request.input,
      candidatePlan: request.plan,
      validationEvidence: [
        { evidenceId: 'source-packet', sourcePacketHash: request.input.sourcePacketHash },
      ],
      previousIssues: request.review?.issues ?? [],
    };
  }
  if (request.stage === LessonModelStage.REPAIR) {
    return {
      lessonInput: request.input,
      candidateHash: request.contentHash,
      candidatePlan: request.plan,
      reviewResult: request.review,
      allowedIssueIds,
    };
  }
  const manifestHash = hashLessonValue(request.manifest);
  const evidenceIndex = request.evidence.map((artifact) => ({
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    digest: artifact.digest,
    sceneId: artifact.sceneId,
    phase: artifact.phase,
  }));
  if (request.stage === LessonModelStage.VISUAL_REPAIR) {
    return {
      contentHash: request.contentHash,
      baseRenderManifestHash: manifestHash,
      approvedPlan: request.plan,
      qualifiedAdjustmentRules: request.input.templates,
      reviewResult: request.review,
      allowedIssueIds,
      evidenceIndex,
      measurements: {
        manifest: request.manifest,
        geometry: readGeometrySummaries(request.evidence),
      },
    };
  }
  return {
    renderManifestHash: manifestHash,
    contentHash: request.contentHash,
    availableModalities: ['images', 'text'],
    requiredCriteria: [
      'readability',
      'hierarchy',
      'continuity',
      'style',
      'timeline',
      'assets',
      'traceCorrectness',
      'checkpoint',
      'pronunciation',
      'motion',
    ],
    approvedPlan: request.plan,
    expectedFrameStates: request.input.traces,
    designTokens: {
      paper: '#f6f3eb',
      forest: '#172f28',
      currentInput: '#f4bd65',
      runningTotal: '#a8e2bf',
      minimumEssentialFontPx: 48,
    },
    qualifiedTemplateRules: request.input.templates,
    evidenceIndex,
    measurements: { manifest: request.manifest, geometry: readGeometrySummaries(request.evidence) },
    previousIssues: request.review?.issues ?? [],
  };
}

function readGeometrySummaries(evidence: LessonModelRequest['evidence']): unknown[] {
  return evidence
    .filter((artifact) => artifact.mimeType === 'application/json')
    .map((artifact) => {
      const raw: unknown = JSON.parse(new TextDecoder().decode(artifact.bytes));
      const parsed = z
        .object({
          measurements: z
            .array(
              z.object({
                frame: z.number().int().min(0).max(9000),
                geometry: LessonGeometrySchema,
              }),
            )
            .min(1)
            .max(100),
        })
        .parse(raw);
      const boxes = parsed.measurements.flatMap((measurement) => measurement.geometry);
      return {
        artifactId: artifact.artifactId,
        digest: artifact.digest,
        sampleCount: parsed.measurements.length,
        minimumFontPx: Math.min(...boxes.map((box) => box.fontPx)),
        maximumHorizontalOverflowPx: Math.max(
          0,
          ...boxes.map((box) => box.scrollWidth - box.clientWidth),
        ),
        maximumVerticalOverflowPx: Math.max(
          0,
          ...boxes.map((box) => box.scrollHeight - box.clientHeight),
        ),
        canvasViolations: boxes.filter(
          (box) =>
            box.x < -1 || box.y < -1 || box.x + box.width > 1921 || box.y + box.height > 1081,
        ).length,
      };
    });
}
