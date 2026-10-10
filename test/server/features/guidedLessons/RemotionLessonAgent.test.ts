import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  LessonRenderLifecycle,
  LessonRenderer,
} from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import type { LessonCodeSandbox } from '../../../../src/server/features/guidedLessons/infrastructure/LessonCodeSandbox.js';
import { LessonCodeSandboxError } from '../../../../src/server/features/guidedLessons/infrastructure/LessonCodeSandbox.js';
import {
  RemotionLessonAgent,
  type RemotionAgentMeasurement,
} from '../../../../src/server/features/guidedLessons/infrastructure/RemotionLessonAgent.js';
import { createLessonFixture } from './LessonFixture.js';

const Source = `import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
export default function Scene({projection}) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{background:'#f6f3eb'}}><div data-lesson-essential style={{fontSize:64}}>{projection.sceneTitle} {frame}</div></AbsoluteFill>;
}`;
const RevisedSource = Source.replace('fontSize:64', 'fontSize:72');
const Identity = {
  compositionBundleHash: 'a'.repeat(64),
  fontBundleHash: 'b'.repeat(64),
  rendererVersion: '4.0.534',
  browserPath: '/synthetic/chrome',
  browserMode: 'chrome-for-testing' as const,
};
const Geometry = [
  {
    fontPx: 64,
    x: 20,
    y: 20,
    width: 800,
    height: 100,
    scrollWidth: 800,
    clientWidth: 800,
    scrollHeight: 100,
    clientHeight: 100,
  },
];
const RequestSchema = z.object({
  instructions: z.string(),
  input: z.array(z.unknown()),
  parallel_tool_calls: z.boolean(),
  store: z.boolean(),
  include: z.array(z.string()),
  max_output_tokens: z.number(),
});

function buildRequest(): Parameters<LessonRenderer['render']>[0] {
  const fixture = createLessonFixture();
  const manifest = fixture.record.manifest;
  if (!manifest) {
    throw new Error('Fixture manifest absent.');
  }
  return {
    revisionId: fixture.record.revisionId,
    input: fixture.input,
    plan: fixture.plan,
    contentHash: manifest.contentHash,
    speechArtifacts: manifest.speechArtifacts.map((descriptor) => ({
      descriptor,
      bytes: new Uint8Array([1, 2, 3, 4]),
    })),
    adjustments: null,
  };
}

function createSandbox() {
  return {
    preview: vi.fn<LessonCodeSandbox['preview']>((_request, frames) =>
      Promise.resolve({
        frames: frames.map((frame) => ({
          frame,
          bytes: new Uint8Array([137, 80, 78, 71, frame]),
          geometry: Geometry,
        })),
      }),
    ),
    renderVideo: vi.fn<LessonCodeSandbox['renderVideo']>(() =>
      Promise.resolve(new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112])),
    ),
  } satisfies LessonCodeSandbox;
}

function callTool(name: string, argumentsValue: unknown, callId = name) {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(argumentsValue),
  };
}

function finish() {
  return {
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: JSON.stringify({ status: 'ready', summary: 'Inspected animated explanation.' }),
        annotations: [],
      },
    ],
  };
}

function respond(
  output: unknown[],
  usage: unknown = {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 10 },
  },
) {
  return Response.json(
    {
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      output,
      usage,
    },
    { headers: { 'x-request-id': 'request_test' } },
  );
}

function readBody(init: RequestInit | undefined): z.infer<typeof RequestSchema> {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected serialized model request.');
  }
  const raw: unknown = JSON.parse(init.body);
  return RequestSchema.parse(raw);
}

function createSequence(sequence: unknown[][], bodies: z.infer<typeof RequestSchema>[] = []) {
  let turn = 0;
  return vi.fn<typeof fetch>((_url, init) => {
    bodies.push(readBody(init));
    const output = sequence[turn % sequence.length];
    turn += 1;
    if (!output) {
      throw new Error('Synthetic sequence absent.');
    }
    return Promise.resolve(respond(output));
  });
}

function basicSequence(): unknown[][] {
  return [
    [callTool('write_scene', { source: Source })],
    [callTool('render_preview', { frames: [0, 15] })],
    [callTool('render_video', {})],
    [finish()],
  ];
}

describe('Remotion coding agent', () => {
  it('preserves an explicitly injected fetch transport across consecutive SDK calls', async () => {
    const fetcher = createSequence(basicSequence());
    await new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
      fetch: fetcher,
      identity: Identity,
    }).render(buildRequest(), new AbortController().signal);
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get('connection')).toBeNull();
    }
  });

  it('writes TSX, sees actual preview images, revises source, and encodes the inspected current source', async () => {
    const sandbox = createSandbox();
    const bodies: z.infer<typeof RequestSchema>[] = [];
    const sequence = [
      [
        {
          type: 'reasoning',
          id: 'rs_test',
          summary: [],
          encrypted_content: 'opaque-encrypted-test',
        },
        callTool('write_scene', { source: Source }),
      ],
      [callTool('render_preview', { frames: [0, 15] })],
      [callTool('write_scene', { source: RevisedSource })],
      [callTool('render_preview', { frames: [0, 29] })],
      [callTool('render_video', {})],
      [finish()],
    ];
    const fetcher = createSequence(sequence, bodies);
    const beforeModelCall = vi.fn<LessonRenderLifecycle['beforeModelCall']>(() =>
      Promise.resolve(),
    );
    const afterModelCall = vi.fn<LessonRenderLifecycle['afterModelCall']>(() => Promise.resolve());
    const measurements: RemotionAgentMeasurement[] = [];
    const agent = new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
      fetch: fetcher,
      identity: Identity,
      onMeasurement: (measurement) => measurements.push(measurement),
    });
    const generated = await agent.render(buildRequest(), new AbortController().signal, {
      beforeModelCall,
      afterModelCall,
    });
    expect(fetcher).toHaveBeenCalledTimes(24);
    expect(beforeModelCall).toHaveBeenCalledTimes(24);
    expect(afterModelCall).toHaveBeenCalledTimes(24);
    expect(afterModelCall).toHaveBeenLastCalledWith(expect.any(String), {
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(sandbox.preview).toHaveBeenCalledTimes(8);
    expect(sandbox.renderVideo).toHaveBeenCalledTimes(4);
    expect(sandbox.renderVideo).toHaveBeenCalledWith(
      expect.objectContaining({ source: RevisedSource }),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(bodies[2])).toContain('data:image/png;base64,');
    expect(JSON.stringify(bodies[2])).toContain('opaque-encrypted-test');
    expect(JSON.stringify(bodies[2])).toContain('function_call_output');
    expect(bodies[0]).toMatchObject({
      parallel_tool_calls: false,
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    expect(generated.artifacts).toHaveLength(16);
    expect(generated.manifest.evidence.filter((item) => item.kind === 'clip')).toHaveLength(4);
    expect(generated.manifest.compositionBundleHash).toBe(Identity.compositionBundleHash);
    const sourceArtifacts = generated.artifacts.filter((item) => item.kind === 'source');
    expect(
      sourceArtifacts.some((item) => new TextDecoder().decode(item.bytes).includes('fontSize:72')),
    ).toBe(true);
    expect(measurements.filter((item) => item.kind === 'model')).toHaveLength(24);
    expect(measurements[0]).toMatchObject({
      kind: 'model',
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      reasoningOutputTokens: 10,
      requestId: 'request_test',
      status: 'completed',
      failure: null,
    });
    expect(JSON.stringify(measurements)).not.toContain('synthetic-test-key');
    expect(JSON.stringify(measurements)).not.toContain('opaque-encrypted-test');
    const pending = vi
      .mocked(sandbox.preview)
      .mock.calls.find(([request]) => request.projection.phase === 'predict');
    expect(
      pending?.[0].projection.visibleTraceStates.every((state) => state.stateView === 'before'),
    ).toBe(true);
    expect(JSON.stringify(pending?.[0].projection)).not.toContain('workedExplanation');
    expect(JSON.stringify(pending?.[0].projection)).not.toContain('teacherAnswerKeys');
  });

  it('delivers bad preview pixels and measurements, blocks encoding, and encodes only after a passing revision', async () => {
    const sandbox = createSandbox();
    sandbox.preview.mockImplementationOnce((_request, frames) =>
      Promise.resolve({
        frames: frames.map((frame) => ({
          frame,
          bytes: new Uint8Array([137, 80, 78, 71, frame]),
          geometry: Geometry.map((box) => ({
            ...box,
            fontPx: 24,
            scrollHeight: 128,
            clientHeight: 125,
          })),
        })),
      }),
    );
    const bodies: z.infer<typeof RequestSchema>[] = [];
    const repairedPhase = [
      [callTool('write_scene', { source: Source })],
      [callTool('render_preview', { frames: [0] })],
      [callTool('render_video', {})],
      [
        callTool('write_scene', { source: RevisedSource }),
        callTool('render_preview', { frames: [0] }),
      ],
      [callTool('render_video', {})],
      [finish()],
    ];
    const fetcher = createSequence(
      [...repairedPhase, ...basicSequence(), ...basicSequence(), ...basicSequence()],
      bodies,
    );
    const generated = await new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
      fetch: fetcher,
      identity: Identity,
    }).render(buildRequest(), new AbortController().signal);
    expect(JSON.stringify(bodies[2])).toContain('data:image/png;base64,');
    expect(JSON.stringify(bodies[2])).toContain('qualityIssues');
    expect(JSON.stringify(bodies[2])).toContain('fontPx');
    expect(JSON.stringify(bodies[2])).toContain('measurement[0]');
    expect(JSON.stringify(bodies[2])).toContain('fontPx=24 < minimumFontPx=48');
    expect(JSON.stringify(bodies[2])).toContain(
      'scrollHeight=128 > clientHeight=125 + tolerancePx=2 (overflowPx=3)',
    );
    expect(JSON.stringify(bodies[3])).toContain('The current preview has layout quality issues');
    expect(sandbox.renderVideo).toHaveBeenCalledTimes(4);
    expect(sandbox.renderVideo.mock.calls[0]?.[0].source).toBe(RevisedSource);
    expect(generated.manifest.evidence.filter((item) => item.kind === 'clip')).toHaveLength(4);
  });

  it('does not allow preview and encoding in the same model turn to count as inspection', async () => {
    const sandbox = createSandbox();
    const bodies: z.infer<typeof RequestSchema>[] = [];
    const fetcher = createSequence(
      [
        [
          callTool('write_scene', { source: Source }),
          callTool('render_preview', { frames: [0] }),
          callTool('render_video', {}),
        ],
        [callTool('render_video', {})],
        [finish()],
      ],
      bodies,
    );
    await new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
      fetch: fetcher,
      identity: Identity,
    }).render(buildRequest(), new AbortController().signal);
    expect(JSON.stringify(bodies[1])).toContain('inspect it on a later model turn first');
    expect(sandbox.renderVideo).toHaveBeenCalledTimes(4);
  });

  it('adds trusted samples for every active caption and visible state when the agent requests only frame zero', async () => {
    const sandbox = createSandbox();
    const fetcher = createSequence([
      [callTool('write_scene', { source: Source })],
      [callTool('render_preview', { frames: [0] })],
      [callTool('render_video', {})],
      [finish()],
    ]);
    await new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
      fetch: fetcher,
      identity: Identity,
    }).render(buildRequest(), new AbortController().signal);
    for (const [request, frames] of vi.mocked(sandbox.preview).mock.calls) {
      expect(frames).toContain(0);
      expect(frames).toContain(request.durationInFrames - 1);
      for (const cue of [...request.projection.narrationCues, ...request.projection.visualCues]) {
        expect(frames).toContain(Math.floor((cue.startFrame + cue.endFrame - 1) / 2));
      }
    }
    expect(vi.mocked(sandbox.preview).mock.calls[0]?.[1].length).toBeGreaterThan(1);
  });

  it('invalidates an older inspected preview when the source changes', async () => {
    const sandbox = createSandbox();
    const bodies: z.infer<typeof RequestSchema>[] = [];
    const fetcher = createSequence(
      [
        [callTool('write_scene', { source: Source }), callTool('render_preview', { frames: [0] })],
        [callTool('write_scene', { source: RevisedSource }), callTool('render_video', {})],
        [callTool('render_preview', { frames: [0] })],
        [callTool('render_video', {})],
        [finish()],
      ],
      bodies,
    );
    await new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
      fetch: fetcher,
      identity: Identity,
    }).render(buildRequest(), new AbortController().signal);
    expect(JSON.stringify(bodies[2])).toContain('inspect it on a later model turn first');
    expect(sandbox.renderVideo).toHaveBeenCalledTimes(4);
  });

  it('settles unknown dispatches once and stops without an implicit retry', async () => {
    const afterModelCall = vi.fn<LessonRenderLifecycle['afterModelCall']>(() => Promise.resolve());
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.reject(
        new TypeError('Private fetch failure text must stay private.', {
          cause: new Error('Private connection detail.', { cause: { code: 'ECONNRESET' } }),
        }),
      ),
    );
    const sandbox = createSandbox();
    const measurements: RemotionAgentMeasurement[] = [];
    await expect(
      new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
        fetch: fetcher,
        identity: Identity,
        onMeasurement: (measurement) => measurements.push(measurement),
      }).render(buildRequest(), new AbortController().signal, {
        beforeModelCall: () => Promise.resolve(),
        afterModelCall,
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(afterModelCall).toHaveBeenCalledExactlyOnceWith(expect.any(String), null);
    expect(sandbox.preview).not.toHaveBeenCalled();
    expect(measurements[0]).toMatchObject({
      kind: 'model',
      status: 'uncertain',
      inputTokens: null,
      failure: {
        category: 'transport',
        httpStatus: null,
        providerCode: null,
        providerType: null,
        providerParam: null,
        transportCode: 'ECONNRESET',
        aborted: false,
      },
    });
    expect(JSON.stringify(measurements)).not.toContain('Private');
  });

  it.each([
    { requestId: 'req_failed-123', expected: 'req_failed-123' },
    { requestId: 'unvalidated provider value', expected: null },
  ])(
    'records only a validated failed-provider request ID ($requestId)',
    async ({ requestId, expected }) => {
      const measurements: RemotionAgentMeasurement[] = [];
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json(
            {
              error: {
                message: 'Synthetic provider failure.',
                type: 'rate_limit_error',
                code: 'rate_limit',
                param: 'input[2].content',
              },
            },
            { status: 429, headers: { 'x-request-id': requestId } },
          ),
        ),
      );
      await expect(
        new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
          fetch: fetcher,
          identity: Identity,
          onMeasurement: (measurement) => measurements.push(measurement),
        }).render(buildRequest(), new AbortController().signal),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(measurements[0]).toMatchObject({
        kind: 'model',
        status: 'uncertain',
        inputTokens: null,
        requestId: expected,
        failure: {
          category: 'api',
          httpStatus: 429,
          providerCode: 'rate_limit',
          providerType: 'rate_limit_error',
          providerParam: 'input[2].content',
          transportCode: null,
          aborted: false,
        },
      });
      expect(JSON.stringify(measurements)).not.toContain('Synthetic provider failure.');
    },
  );

  it('omits unsafe provider identifiers and parameters from failure measurements', async () => {
    const measurements: RemotionAgentMeasurement[] = [];
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              message: 'Private provider error body.',
              code: 'sk-proj-synthetic-private-value',
              type: 'unsafe type with whitespace',
              param: 'input[0]../private/path',
            },
          },
          { status: 400 },
        ),
      ),
    );
    await expect(
      new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
        fetch: fetcher,
        identity: Identity,
        onMeasurement: (measurement) => measurements.push(measurement),
      }).render(buildRequest(), new AbortController().signal),
    ).rejects.toThrow();
    expect(measurements[0]).toMatchObject({
      failure: {
        category: 'api',
        httpStatus: 400,
        providerCode: null,
        providerType: null,
        providerParam: null,
      },
    });
    expect(JSON.stringify(measurements)).not.toMatch(/Private|sk-proj|whitespace|private\/path/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports cancellation separately and settles its uncertain dispatch without retrying', async () => {
    const controller = new AbortController();
    const measurements: RemotionAgentMeasurement[] = [];
    const afterModelCall = vi.fn<LessonRenderLifecycle['afterModelCall']>(() => Promise.resolve());
    const fetcher = vi.fn<typeof fetch>(() => {
      controller.abort();
      return Promise.reject(new DOMException('Private cancellation detail.', 'AbortError'));
    });
    await expect(
      new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
        fetch: fetcher,
        identity: Identity,
        onMeasurement: (measurement) => measurements.push(measurement),
      }).render(buildRequest(), controller.signal, {
        beforeModelCall: () => Promise.resolve(),
        afterModelCall,
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(afterModelCall).toHaveBeenCalledExactlyOnceWith(expect.any(String), null);
    expect(measurements[0]).toMatchObject({
      status: 'uncertain',
      failure: { category: 'aborted', aborted: true, httpStatus: null },
    });
    expect(JSON.stringify(measurements)).not.toContain('Private cancellation detail.');
  });

  it('preserves actual usage even when the provider returns an unsupported response shape', async () => {
    const afterModelCall = vi.fn<LessonRenderLifecycle['afterModelCall']>(() => Promise.resolve());
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(respond([{ type: 'unsupported' }])));
    const measurements: RemotionAgentMeasurement[] = [];
    await expect(
      new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
        fetch: fetcher,
        identity: Identity,
        onMeasurement: (measurement) => measurements.push(measurement),
      }).render(buildRequest(), new AbortController().signal, {
        beforeModelCall: () => Promise.resolve(),
        afterModelCall,
      }),
    ).rejects.toThrow();
    expect(afterModelCall).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(measurements[0]).toMatchObject({
      status: 'invalid',
      failure: { category: 'response', aborted: false },
    });
  });

  it('stops when usage is missing even if the provider says it completed', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(respond([callTool('write_scene', { source: Source })], null)),
    );
    await expect(
      new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
        fetch: fetcher,
        identity: Identity,
      }).render(buildRequest(), new AbortController().signal),
    ).rejects.toThrow('uncertain usage');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects ready text without a video and limits an agent that only keeps rewriting', async () => {
    const ready = vi.fn<typeof fetch>(() => Promise.resolve(respond([finish()])));
    await expect(
      new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
        fetch: ready,
        identity: Identity,
      }).render(buildRequest(), new AbortController().signal),
    ).rejects.toThrow('has not rendered');
    const rewriting = createSequence([[callTool('write_scene', { source: Source })]]);
    await expect(
      new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
        fetch: rewriting,
        identity: Identity,
      }).render(buildRequest(), new AbortController().signal),
    ).rejects.toThrow('turn limit');
    expect(rewriting).toHaveBeenCalledTimes(12);
  });

  it('returns schema failures to the agent and only calls the sandbox with valid frame requests', async () => {
    const sandbox = createSandbox();
    const bodies: z.infer<typeof RequestSchema>[] = [];
    const fetcher = createSequence(
      [
        [callTool('write_scene', { source: Source })],
        [callTool('render_preview', { frames: [0, 0], arbitraryPath: '/tmp/unsafe' })],
        [callTool('render_preview', { frames: [0] })],
        [callTool('render_video', {})],
        [finish()],
      ],
      bodies,
    );
    await new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
      fetch: fetcher,
      identity: Identity,
    }).render(buildRequest(), new AbortController().signal);
    expect(JSON.stringify(bodies[2])).toContain('Tool arguments');
    expect(sandbox.preview).toHaveBeenCalledTimes(4);
  });

  it('returns bounded compile diagnostics so the agent can repair the actual error', async () => {
    const sandbox = createSandbox();
    vi.mocked(sandbox.preview).mockRejectedValueOnce(
      new LessonCodeSandboxError('compile', 'Line 4: JSX element is not closed.'),
    );
    const bodies: z.infer<typeof RequestSchema>[] = [];
    const fetcher = createSequence(
      [
        [callTool('write_scene', { source: Source })],
        [callTool('render_preview', { frames: [0] })],
        [callTool('write_scene', { source: RevisedSource })],
        [callTool('render_preview', { frames: [0] })],
        [callTool('render_video', {})],
        [finish()],
      ],
      bodies,
    );
    await new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', sandbox, {
      fetch: fetcher,
      identity: Identity,
    }).render(buildRequest(), new AbortController().signal);
    expect(JSON.stringify(bodies[2])).toContain('JSX element is not closed');
    expect(JSON.stringify(bodies[2])).toContain('compile');
    expect(sandbox.renderVideo).toHaveBeenCalledTimes(4);
  });

  it('checks the isolated renderer before any paid model dispatch and hides raw readiness errors', async () => {
    const fetcher = createSequence(basicSequence());
    const sandbox = createSandbox();
    const checkReady = vi.fn<NonNullable<LessonCodeSandbox['checkReady']>>(() =>
      Promise.reject(new Error('Private configuration must not escape.')),
    );
    const agent = new RemotionLessonAgent(
      'synthetic-test-key',
      'gpt-5.4',
      {
        ...sandbox,
        checkReady,
      },
      { fetch: fetcher, identity: Identity },
    );
    await expect(agent.checkReady(new AbortController().signal)).rejects.toThrow(
      'ready isolated render sandbox',
    );
    expect(checkReady).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not dispatch when durable reservation fails or provider configuration is missing', async () => {
    const fetcher = createSequence(basicSequence());
    const agent = new RemotionLessonAgent('synthetic-test-key', 'gpt-5.4', createSandbox(), {
      fetch: fetcher,
      identity: Identity,
    });
    await expect(
      agent.render(buildRequest(), new AbortController().signal, {
        beforeModelCall: () => Promise.reject(new Error('Stale claim.')),
        afterModelCall: () => Promise.resolve(),
      }),
    ).rejects.toThrow('Stale claim');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      new RemotionLessonAgent(undefined, 'gpt-5.4', createSandbox(), {
        fetch: fetcher,
        identity: Identity,
      }).render(buildRequest(), new AbortController().signal),
    ).rejects.toThrow('configured model provider');
  });
});
