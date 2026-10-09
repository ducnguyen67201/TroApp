import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';

const RequestSchema = z.object({
  input: z.array(z.unknown()),
  instructions: z.string().optional(),
  tool_choice: z.unknown().optional(),
  tools: z.array(z.looseObject({ name: z.string().optional() })),
  stream: z.literal(false).optional(),
});
const ToolRequestSchema = z.strictObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
const WatchArgsSchema = z.strictObject({
  watch_id: z.uuid(),
  input_only: z.boolean().optional(),
  regions: z
    .array(z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }))
    .optional(),
});
const EpochArgsSchema = z.strictObject({
  task_epoch: z.uuid(),
  presentation_version: z.literal(2).optional(),
});
const PreviewArgsSchema = z.object({
  presentation_version: z.literal(2),
  capture_id: z.string(),
  steps: z.array(z.unknown()).max(8),
});

export const FlowScenario = {
  CHAT_ONLY: 'chat_only',
  CHAT_ONLY_AFTER_STEP: 'chat_only_after_step',
  JOURNEY: 'journey',
  QUESTION: 'question',
  BAD_RECEIPT: 'bad_receipt',
  WATCH_FAILURE: 'watch_failure',
  STALE_COMPLETION: 'stale_completion',
  MODEL_PENDING: 'model_pending',
  MODEL_NETWORK_FAILURE: 'model_network_failure',
  SDK_CONNECTION_FAILURE: 'sdk_connection_failure',
  MODEL_SERVICE_FAILURE: 'model_service_failure',
  STALE_PREVIEW: 'stale_preview',
  INPUT_DURING_PROPOSAL: 'input_during_proposal',
  BACKGROUND_ANIMATION: 'background_animation',
  REFRESH_FAILURE: 'refresh_failure',
} as const;

export type FlowScenario = (typeof FlowScenario)[keyof typeof FlowScenario];

const modelFailureScenarios = new Set<FlowScenario>([
  FlowScenario.MODEL_NETWORK_FAILURE,
  FlowScenario.SDK_CONNECTION_FAILURE,
  FlowScenario.MODEL_SERVICE_FAILURE,
]);

const toolProperties: Record<string, Record<string, unknown>> = {
  get_desktop_state: { max_image_dimension: { type: 'integer' } },
  refresh_cursor_guidance_capture: {
    capture_id: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
    max_image_dimension: { type: 'integer' },
  },
  show_cursor_sequence: {
    presentation_version: { type: 'integer' },
    capture_id: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  set_cursor_companion_mode: { mode: { type: 'string' }, label: { type: 'string' } },
  cancel_cursor_sequence: {},
  get_cursor_companion_state: {},
  get_cursor_companion_capabilities: {},
  begin_cursor_guidance_task: {
    task_epoch: { type: 'string' },
    presentation_version: { type: 'integer' },
  },
  end_cursor_guidance_task: { task_epoch: { type: 'string' } },
  begin_desktop_watch: { watch_id: { type: 'string' }, input_only: { type: 'boolean' } },
  read_desktop_watch: {
    watch_id: { type: 'string' },
    regions: { type: 'array', items: { type: 'object' } },
  },
  bind_companion_hud_cursor: { group: { type: 'string' } },
  end_desktop_watch: { watch_id: { type: 'string' } },
};

/** An independent wire fixture, not a replacement teaching runner or SDK.
 * All HTTP stays on loopback. Requests and synthetic pixels exist only in memory. */
export class TeachingFlowFixture {
  private server: Server | null = null;
  url = '';
  scenario: FlowScenario = FlowScenario.JOURNEY;
  goal = '';
  requests = 0;
  segments = 0;
  previews = 0;
  captures = 0;
  watchStarts = 0;
  watchEnds = 0;
  epochStarts = 0;
  epochEnds = 0;
  private watchId: string | null = null;
  private epoch: string | null = null;
  private captureId = '';
  private screenRevision = 1;
  private inputRevision = 0;
  private buttonsDown = false;
  private screen = 'desktop';
  private modelPhase = 0;
  private modelFailureSent = false;
  private observationCaptureId = '';
  private lastPresentationId: string | null = null;
  failure: Error | null = null;
  modelPending = false;

  reset(scenario: FlowScenario, goal: string): void {
    assert.equal(this.watchId, null, 'The previous lesson must release its watch.');
    this.scenario = scenario;
    this.goal = goal;
    this.requests = 0;
    this.segments = 0;
    this.previews = 0;
    this.captures = 0;
    this.watchStarts = 0;
    this.watchEnds = 0;
    this.epochStarts = 0;
    this.epochEnds = 0;
    this.screenRevision = 1;
    this.inputRevision = 0;
    this.buttonsDown = false;
    this.screen = 'desktop';
    this.modelPhase = 0;
    this.modelFailureSent = false;
    this.lastPresentationId = null;
    this.observationCaptureId = '';
    this.failure = null;
    this.modelPending = false;
  }

  changeScreen(screen: string, hasInput = true, buttonsDown = false): void {
    this.screen = screen;
    this.screenRevision += 1;
    this.inputRevision += hasInput ? 1 : 0;
    this.buttonsDown = buttonsDown;
  }

  releaseButtons(): void {
    this.buttonsDown = false;
  }

  readTools(): unknown[] {
    return Object.entries(toolProperties).map(([name, properties]) => ({
      name,
      description: `Contract fixture for ${name}`,
      inputSchema: { type: 'object', properties, additionalProperties: true },
      annotations: { readOnlyHint: name.startsWith('get_') || name === 'read_desktop_watch' },
    }));
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.answerHttpRequest(request, response).catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error('Fixture protocol failed.');
        response.writeHead(500).end(
          JSON.stringify({
            error: { message: 'Teaching contract protocol failed.', type: 'contract_error' },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    assert.ok(address && typeof address === 'object');
    this.url = `http://127.0.0.1:${String(address.port)}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    this.server = null;
  }

  assertReleased(): void {
    assert.equal(this.watchId, null, 'Lesson watch leaked.');
    assert.equal(this.watchStarts, this.watchEnds, 'Every watch must end.');
    assert.equal(this.epochStarts, this.epochEnds, 'Every preview epoch must end or disconnect.');
    if (this.failure) {
      throw this.failure;
    }
  }

  private async answerHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    assert.equal(request.method, 'POST');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const value: unknown = chunk;
      assert.ok(Buffer.isBuffer(value));
      bytes += value.length;
      assert.ok(bytes < 2_000_000, 'Synthetic contract request exceeded its bound.');
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (
      request.url === '/v1/responses' &&
      modelFailureScenarios.has(this.scenario) &&
      !this.modelFailureSent
    ) {
      RequestSchema.parse(body);
      this.modelFailureSent = true;
      if (this.scenario === FlowScenario.SDK_CONNECTION_FAILURE) {
        request.socket.destroy();
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            type: 'api_error',
            code: 'tro_model_gateway_failed',
            diagnostics: {
              gatewayRequestId: 'req-contract',
              attemptNumber: 2,
              durationMs: 560,
              ...(this.scenario === FlowScenario.MODEL_SERVICE_FAILURE
                ? {
                    reason: 'provider_rejected',
                    providerStatus: 503,
                    providerErrorCode: 'server_error',
                  }
                : { reason: 'provider_network_failed', networkCode: 'EPIPE' }),
            },
          },
        }),
      );
      return;
    }
    const result =
      request.url === '/tools'
        ? this.callTool(ToolRequestSchema.parse(body))
        : request.url === '/disconnect'
          ? this.releaseConnection()
          : request.url === '/v1/responses'
            ? this.answerModel(RequestSchema.parse(body))
            : undefined;
    assert.notEqual(result, undefined, 'Only the local contract endpoints are allowed.');
    if (request.url === '/v1/responses' && this.scenario === FlowScenario.MODEL_PENDING) {
      this.modelPending = true;
      await new Promise<void>((resolve) => {
        response.once('close', resolve);
      });
      this.modelPending = false;
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  }

  private releaseConnection(): unknown {
    if (this.epoch) {
      this.epochEnds += 1;
      this.epoch = null;
    }
    if (this.watchId) {
      this.watchEnds += 1;
      this.watchId = null;
    }
    return { released: true };
  }

  private readObservation(): unknown {
    return {
      watch_id: this.watchId,
      screen_revision: this.screenRevision,
      input_revision: this.inputRevision,
      ready: true,
      changed_fraction: 0.2,
      quiet_ms: 1000,
      buttons_down: this.buttonsDown,
      screen_width: 1000,
      screen_height: 800,
    };
  }

  private callTool(request: z.infer<typeof ToolRequestSchema>): unknown {
    const args = request.arguments;
    let structuredContent: unknown;
    switch (request.name) {
      case 'bind_companion_hud_cursor':
        structuredContent = { applied: true };
        break;
      case 'begin_desktop_watch': {
        const watch = WatchArgsSchema.parse(args);
        if (this.scenario === FlowScenario.WATCH_FAILURE) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'watch_unavailable' }],
            structuredContent: { code: 'watch_unavailable' },
          };
        }
        assert.equal(this.watchId, null);
        this.watchId = watch.watch_id;
        this.watchStarts += 1;
        structuredContent = this.readObservation();
        break;
      }
      case 'read_desktop_watch':
        assert.equal(WatchArgsSchema.parse(args).watch_id, this.watchId);
        structuredContent = this.readObservation();
        break;
      case 'end_desktop_watch':
        WatchArgsSchema.parse(args);
        if (this.watchId) {
          this.watchEnds += 1;
          this.watchId = null;
        }
        structuredContent = { ended: true };
        break;
      case 'get_cursor_companion_capabilities':
        structuredContent = {
          presentation_versions: [2],
          task_lifecycle: true,
          paired_presentation: true,
          display_scope: 'primary',
          gestures: ['circle'],
          max_steps: 8,
          max_duration_ms: 15000,
        };
        break;
      case 'begin_cursor_guidance_task': {
        const epoch = EpochArgsSchema.parse(args);
        assert.equal(epoch.presentation_version, 2);
        assert.equal(this.epoch, null);
        this.epoch = epoch.task_epoch;
        this.epochStarts += 1;
        this.segments += 1;
        this.modelPhase = 0;
        this.lastPresentationId = null;
        structuredContent = {
          status: 'task_ready',
          task_epoch: this.epoch,
          following: true,
          active: false,
        };
        break;
      }
      case 'end_cursor_guidance_task': {
        assert.equal(EpochArgsSchema.parse(args).task_epoch, this.epoch);
        structuredContent = {
          status: 'task_ended',
          task_epoch: this.epoch,
          following: true,
          active: false,
        };
        this.epoch = null;
        this.epochEnds += 1;
        break;
      }
      case 'get_desktop_state':
        assert.ok(this.watchId);
        this.captureId = randomUUID();
        this.observationCaptureId = this.captureId;
        this.captures += 1;
        return {
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=',
            },
            { type: 'text', text: `Synthetic screen: ${this.screen}` },
          ],
          structuredContent: {
            capture_id: this.captureId,
            display: 'primary',
            screen_width: 1000,
            screen_height: 800,
            screenshot_width: 1,
            screenshot_height: 1,
            scale_factor: 1,
            observation: this.readObservation(),
          },
        };
      case 'refresh_cursor_guidance_capture': {
        if (this.scenario === FlowScenario.REFRESH_FAILURE) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Synthetic capture transport error' }],
          };
        }
        assert.equal(args['capture_id'], this.captureId);
        assert.ok(this.epoch);
        const matched = this.scenario !== FlowScenario.STALE_PREVIEW || this.modelPhase > 2;
        this.captureId = randomUUID();
        structuredContent = {
          matched,
          capture_id: matched ? this.captureId : null,
          reason: matched ? 'target_unchanged' : 'target_changed',
        };
        break;
      }
      case 'show_cursor_sequence': {
        const preview = PreviewArgsSchema.parse(args);
        assert.ok(this.epoch);
        assert.equal(preview.capture_id, this.captureId);
        assert.equal(args['hud_group'], '33333333-3333-4333-8333-333333333333');
        const message = z
          .object({ text: z.string(), lessonId: z.uuid(), stepId: z.uuid() })
          .parse(args['teaching_message']);
        assert.ok(message.text.length > 0, 'The native cue must carry the admitted instruction.');
        assert.ok(args['teaching_locale'] === 'en' || args['teaching_locale'] === 'vi');
        this.previews += preview.steps.length > 0 ? 1 : 0;
        this.lastPresentationId = z.uuid().parse(args['presentation_id']);
        structuredContent = {
          status: 'presented',
          following: true,
          active: false,
          receipt: {
            presentation_version: 2,
            task_epoch: this.scenario === FlowScenario.BAD_RECEIPT ? randomUUID() : this.epoch,
            sequence_id: randomUUID(),
            presentation_id: args['presentation_id'],
            lesson_id: message.lessonId,
            step_id: message.stepId,
            message_presented: true,
            drawing_presented: preview.steps.length > 0,
            text_only: args['text_only'] === true,
            interrupted: false,
          },
        };
        break;
      }
      case 'set_cursor_companion_mode':
      case 'cancel_cursor_sequence':
      case 'get_cursor_companion_state':
        structuredContent = {
          status: 'state',
          following: args['mode'] !== 'hidden',
          active: false,
        };
        break;
      default:
        throw new Error('Unexpected desktop tool in teaching contract.');
    }
    return { content: [{ type: 'text', text: 'Contract tool result' }], structuredContent };
  }

  private answerModel(request: z.infer<typeof RequestSchema>): unknown {
    this.requests += 1;
    if (request.tools.length === 0) {
      assert.match(request.instructions ?? '', /Translate the supplied teaching message/);
      const text = request.instructions?.includes('Vietnamese')
        ? 'Nhập youtube.com rồi nhấn Enter.'
        : 'Type youtube.com, then press Enter.';
      return {
        id: `resp_${randomUUID()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: 'gpt-5.4',
        output: [
          {
            id: `msg_${randomUUID()}`,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify({ text }), annotations: [] }],
          },
        ],
        error: null,
        incomplete_details: null,
      };
    }
    const input = JSON.stringify(request.input);
    assert.ok(input.includes(this.goal), 'Every SDK segment must retain the original goal.');

    assert.ok(
      !request.tools.some((tool) => tool.name?.includes('desktop_watch')),
      'Host watches must never be exposed to the model.',
    );
    assert.ok(
      !request.tools.some((tool) => tool.name === 'refresh_cursor_guidance_capture'),
      'Cue comparison is a host-only local operation.',
    );
    const goalSchema = z.object({
      id: z.uuid(),
      criteria: z.array(z.object({ id: z.uuid(), description: z.string() })),
    });
    const goals: z.infer<typeof goalSchema>[] = [];
    let checkpointId: string | null = null;
    // Read actual host-returned IDs from SDK tool outputs and context packets.
    const inspect = (value: unknown, depth = 0): void => {
      if (depth > 12) {
        return;
      }
      if (typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          inspect(parsed, depth + 1);
        } catch {
          /* Ordinary text */
        }
      } else if (Array.isArray(value)) {
        for (const item of value) {
          inspect(item, depth + 1);
        }
      } else if (value !== null && typeof value === 'object') {
        const goal = goalSchema.safeParse(value);
        if (goal.success) {
          goals.push(goal.data);
        }
        const receipt = z.object({ stepId: z.uuid(), presentationId: z.uuid() }).safeParse(value);
        if (receipt.success) {
          checkpointId = receipt.data.stepId;
        }
        for (const item of Object.values(value)) {
          inspect(item, depth + 1);
        }
      }
    };
    inspect(request.input);
    const goal = goals.at(-1);
    const phase = this.modelPhase++;
    const question = this.scenario === FlowScenario.QUESTION && this.segments === 1;
    const staleCompletion = this.scenario === FlowScenario.STALE_COMPLETION && this.segments === 1;
    const complete = this.screen === 'youtube' || staleCompletion;
    const omitPresentation =
      (this.scenario === FlowScenario.CHAT_ONLY && this.segments === 1) ||
      (this.scenario === FlowScenario.CHAT_ONLY_AFTER_STEP && this.segments > 1);
    const call = (name: string, args: unknown): unknown[] => [
      {
        type: 'function_call',
        id: `fc_${randomUUID()}`,
        call_id: `call_${randomUUID()}`,
        name,
        status: 'completed',
        arguments: JSON.stringify(args),
      },
    ];
    let output: unknown[];
    if (!goal) {
      output = call('define_teaching_goal', {
        purpose: 'walkthrough',
        outcome: 'YouTube is open',
        criteria: ['YouTube is visibly open'],
      });
    } else if (this.scenario === FlowScenario.STALE_PREVIEW && phase === 2) {
      output = call('get_desktop_state', {});
    } else if (!question && !complete && !omitPresentation && !this.lastPresentationId) {
      const target = {
        label: this.screen === 'browser' ? 'Address bar' : 'Chrome icon',
        bounds: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 },
      };
      const action = ['focused', 'partial'].includes(this.screen)
        ? { kind: 'type', target, focused: true, text: 'youtube.com', submit: true }
        : this.screen === 'loading'
          ? { kind: 'wait', evidence: 'Loading indicator visible' }
          : { kind: 'click', target };
      const instruction = ['focused', 'partial'].includes(this.screen)
        ? 'Type youtube.com, then press Enter.'
        : this.screen === 'loading'
          ? 'Wait for YouTube to load.'
          : this.screen === 'browser'
            ? 'Click the address bar.'
            : 'Open Chrome from the Dock.';
      output = call('present_teaching_step', {
        captureId: this.observationCaptureId,
        goalRevisionId: goal.id,
        checkpointId: ['partial', 'loading'].includes(this.screen) ? checkpointId : null,
        previousStepAssessment:
          this.segments === 1 ? null : this.screen === 'wrong_app' ? 'deviated' : 'reached',
        assessmentEvidence: `Observed ${this.screen}`,
        instruction,
        expectedResult: 'Next requested checkpoint is visible',
        action,
      });
      if (this.scenario === FlowScenario.INPUT_DURING_PROPOSAL && this.segments <= 3) {
        this.changeScreen('changed_target');
        // One proposal only; return and let the host observe the input in the next cycle.
        this.lastPresentationId = 'superseded';
      }
    } else {
      const ids: string[] = [];
      const findReceipt = (value: unknown, depth = 0): void => {
        if (depth > 12) {
          return;
        }
        if (typeof value === 'string') {
          try {
            const parsed: unknown = JSON.parse(value);
            findReceipt(parsed, depth + 1);
          } catch {
            /* Ordinary text */
          }
        } else if (Array.isArray(value)) {
          for (const item of value) {
            findReceipt(item, depth + 1);
          }
        } else if (value !== null && typeof value === 'object') {
          const receipt = z
            .object({ admitted: z.literal(true), presentationId: z.uuid() })
            .safeParse(value);
          if (receipt.success) {
            ids.push(receipt.data.presentationId);
          }
          for (const item of Object.values(value)) {
            findReceipt(item, depth + 1);
          }
        }
      };
      findReceipt(request.input);
      const reply = {
        disposition: question
          ? 'ask'
          : complete
            ? 'complete'
            : this.screen === 'loading'
              ? 'observe_again'
              : 'await_activity',
        presentationId: complete || question ? null : (ids.at(-1) ?? null),
        goalRevisionId: goal.id,
        captureId: this.observationCaptureId,
        observationSummary: `Observed ${this.screen}`,
        message: question
          ? 'Which browser would you like to use?'
          : complete
            ? 'YouTube is open.'
            : null,
        reason: question
          ? 'Browser preference is missing'
          : this.screen === 'loading'
            ? 'Page loading'
            : null,
        goalEvidence: complete
          ? goal.criteria.map((criterion) => ({
              criterionId: criterion.id,
              captureId: this.observationCaptureId,
              observation: 'YouTube home is visible',
            }))
          : [],
      };
      if (staleCompletion) {
        this.changeScreen('wrong_app');
      }
      output = [
        {
          id: `msg_${randomUUID()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }],
        },
      ];
    }
    if (this.scenario === FlowScenario.BACKGROUND_ANIMATION && this.segments === 1 && phase > 0) {
      this.screenRevision += 1;
    }
    return {
      id: `resp_${randomUUID()}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: 'gpt-5.4',
      output,
      error: null,
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
  }
}
