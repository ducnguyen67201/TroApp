import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DockerLessonCodeSandbox,
  type LessonDockerCommands,
} from '../../../../src/server/features/guidedLessons/infrastructure/DockerLessonCodeSandbox.js';
import {
  LessonCodeLimits,
  type LessonCodeRequest,
} from '../../../../src/server/features/guidedLessons/infrastructure/LessonCodeSandbox.js';
import { createLessonPlaybackFixture } from './LessonPlaybackFixture.js';

const Png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const Mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const Geometry = [
  {
    fontPx: 48,
    x: 60,
    y: 60,
    width: 800,
    height: 100,
    scrollWidth: 800,
    clientWidth: 800,
    scrollHeight: 100,
    clientHeight: 100,
  },
];

function createRequest(): LessonCodeRequest {
  return {
    source:
      'export default function Scene(){return <div data-lesson-essential>Running total</div>}',
    projection: createLessonPlaybackFixture().projection,
    durationInFrames: 30,
  };
}

function createCommands() {
  const run = vi.fn<LessonDockerCommands['run']>();
  run.mockImplementation((arguments_) => {
    const source = arguments_[5];
    if (arguments_[0] === 'exec' && source) {
      const bytes = source.endsWith('.png')
        ? Png
        : source.endsWith('.mp4')
          ? Mp4
          : Buffer.from(JSON.stringify(Geometry));
      return Promise.resolve({ exitCode: 0, stdout: Buffer.from(bytes).toString('base64') });
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: arguments_[0] === 'exec' ? 'ready' : 'container',
    });
  });
  return { run };
}

function readInputDirectory(arguments_: readonly string[]): string {
  const mount = arguments_.find((argument) => argument.startsWith('type=bind,src='));
  if (!mount) {
    throw new Error('Input mount absent.');
  }
  return mount.slice('type=bind,src='.length).split(',dst=')[0] ?? '';
}

describe('DockerLessonCodeSandbox', () => {
  it('checks the Linux Docker daemon and exact local image platform without creating or pulling a container', async () => {
    const commands = createCommands();
    commands.run.mockImplementation((arguments_) =>
      Promise.resolve({
        exitCode: 0,
        stdout: arguments_[0] === 'info' ? 'linux\n' : 'linux/amd64\n',
      }),
    );
    await expect(
      new DockerLessonCodeSandbox({ commands }).checkReady(new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(commands.run.mock.calls.map(([arguments_]) => arguments_)).toEqual([
      ['info', '--format', '{{.OSType}}'],
      ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', 'tro-lesson-renderer:local'],
    ]);
  });

  it.each([
    { daemon: 'windows', image: 'linux/amd64', imageExitCode: 0, reason: 'Linux containers' },
    { daemon: 'linux', image: '', imageExitCode: 1, reason: 'Build the Linux AMD64' },
    { daemon: 'linux', image: 'linux/arm64', imageExitCode: 0, reason: 'Build the Linux AMD64' },
  ])(
    'rejects an unavailable or unsupported renderer before paid dispatch: $image',
    async (fixture) => {
      const commands = createCommands();
      commands.run.mockImplementation((arguments_) =>
        Promise.resolve(
          arguments_[0] === 'info'
            ? { exitCode: 0, stdout: fixture.daemon }
            : { exitCode: fixture.imageExitCode, stdout: fixture.image },
        ),
      );
      await expect(
        new DockerLessonCodeSandbox({ commands }).checkReady(new AbortController().signal),
      ).rejects.toThrow(fixture.reason);
      expect(
        commands.run.mock.calls.some(
          ([arguments_]) => arguments_[0] === 'run' || arguments_[0] === 'pull',
        ),
      ).toBe(false);
    },
  );

  it('isolates agent source and copies only fixed bounded preview files before confirmed removal', async () => {
    const commands = createCommands();
    const request = createRequest();
    let inputDirectory = '';
    const normalRun = commands.run.getMockImplementation();
    if (!normalRun) {
      throw new Error('Command implementation absent.');
    }
    commands.run.mockImplementation(async (arguments_, options) => {
      if (arguments_[0] === 'run') {
        inputDirectory = readInputDirectory(arguments_);
        expect(await readFile(join(inputDirectory, 'Scene.tsx'), 'utf8')).toBe(request.source);
        const input: unknown = JSON.parse(
          await readFile(join(inputDirectory, 'Input.json'), 'utf8'),
        );
        expect(input).toEqual({
          projection: request.projection,
          durationInFrames: 30,
          mode: 'preview',
          frames: [0, 29],
        });
      }
      return normalRun(arguments_, options);
    });
    const result = await new DockerLessonCodeSandbox({ commands }).preview(
      request,
      [0, 29],
      new AbortController().signal,
    );
    expect(
      result.frames.map((frame) => ({ frame: frame.frame, geometry: frame.geometry })),
    ).toEqual([
      { frame: 0, geometry: Geometry },
      { frame: 29, geometry: Geometry },
    ]);
    const arguments_ = commands.run.mock.calls[0]?.[0];
    expect(arguments_).toEqual(
      expect.arrayContaining([
        '--detach',
        '--init',
        '--rm',
        '--read-only',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '1000:1000',
        '--pids-limit',
        '256',
        '--memory',
        '2g',
        '--memory-swap',
        '2g',
        '--cpus',
        '2',
        '--platform',
        'linux/amd64',
        `type=bind,src=${inputDirectory},dst=/render/input,readonly`,
        'type=tmpfs,dst=/render/output,tmpfs-size=201326592,tmpfs-mode=1777',
      ]),
    );
    expect(arguments_?.join(' ')).not.toMatch(/docker\.sock|OPENAI|DATABASE_URL|--privileged/);
    expect(commands.run.mock.calls.at(-1)?.[0]).toEqual([
      'rm',
      '--force',
      expect.stringMatching(/^tro-lesson-/),
    ]);
    await expect(access(dirname(inputDirectory))).rejects.toThrow();
  });

  it('returns silent rendered MP4 bytes and respects a configured image', async () => {
    const commands = createCommands();
    const video = await new DockerLessonCodeSandbox({
      image: 'tro-lesson-renderer:test',
      commands,
    }).renderVideo(createRequest(), new AbortController().signal);
    expect(Array.from(video)).toEqual(Array.from(Mp4));
    expect(commands.run.mock.calls[0]?.[0]).toContain('tro-lesson-renderer:test');
    expect(
      commands.run.mock.calls.filter(([arguments_]) => arguments_[0] === 'exec' && arguments_[5]),
    ).toHaveLength(1);
  });

  it.each([
    { frames: [] },
    { frames: [30] },
    { frames: [-1] },
    { frames: [0, 0] },
    { frames: Array.from({ length: 33 }, (_, index) => index) },
  ])('rejects invalid preview samples before dispatch: $frames', async ({ frames }) => {
    const commands = createCommands();
    await expect(
      new DockerLessonCodeSandbox({ commands }).preview(
        createRequest(),
        frames,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(commands.run).not.toHaveBeenCalled();
  });

  it('rejects oversized UTF-8 source before starting Docker', async () => {
    const commands = createCommands();
    await expect(
      new DockerLessonCodeSandbox({ commands }).preview(
        { ...createRequest(), source: 'ư'.repeat(60_001) },
        [0],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(commands.run).not.toHaveBeenCalled();
  });

  it('kills and removes the active container on cancellation and admits a later render', async () => {
    const commands = createCommands();
    const controller = new AbortController();
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((fulfill) => {
      enter = fulfill;
    });
    commands.run.mockImplementation(async (arguments_, options) => {
      if (arguments_[0] === 'exec') {
        enter?.();
        await new Promise<void>((_fulfill, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('cancelled'));
            },
            {
              once: true,
            },
          );
        });
      }
      return { exitCode: 0, stdout: '' };
    });
    const sandbox = new DockerLessonCodeSandbox({ commands });
    const active = sandbox.preview(createRequest(), [0], controller.signal);
    await entered;
    await expect(
      sandbox.preview(createRequest(), [0], new AbortController().signal),
    ).rejects.toThrow('busy');
    controller.abort();
    await expect(active).rejects.toThrow('cancelled');
    expect(commands.run.mock.calls.at(-1)?.[0]?.slice(0, 2)).toEqual(['rm', '--force']);
    const defaults = createCommands();
    const implementation = defaults.run.getMockImplementation();
    if (!implementation) {
      throw new Error('Command implementation absent.');
    }
    commands.run.mockImplementation(implementation);
    await expect(
      sandbox.preview(createRequest(), [0], new AbortController().signal),
    ).resolves.toMatchObject({
      frames: [{ frame: 0 }],
    });
  });

  it('removes the container when the wall-clock deadline expires', async () => {
    const commands = createCommands();
    commands.run.mockImplementation(async (arguments_, options) => {
      if (arguments_[0] === 'exec') {
        await new Promise<void>((_fulfill, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('deadline'));
            },
            {
              once: true,
            },
          );
          if (options.signal?.aborted) {
            reject(new Error('deadline'));
          }
        });
      }
      return { exitCode: 0, stdout: '' };
    });
    await expect(
      new DockerLessonCodeSandbox({ commands, deadlineMs: 20 }).preview(
        createRequest(),
        [0],
        new AbortController().signal,
      ),
    ).rejects.toThrow('deadline');
    expect(commands.run.mock.calls.at(-1)?.[0]?.slice(0, 2)).toEqual(['rm', '--force']);
  });

  it('keeps admission closed if Docker cannot confirm container removal', async () => {
    const commands = createCommands();
    const normalRun = commands.run.getMockImplementation();
    if (!normalRun) {
      throw new Error('Command implementation absent.');
    }
    commands.run.mockImplementation((arguments_, options) =>
      arguments_[0] === 'rm'
        ? Promise.resolve({ exitCode: 1, stdout: '' })
        : normalRun(arguments_, options),
    );
    const sandbox = new DockerLessonCodeSandbox({ commands });
    await expect(
      sandbox.preview(createRequest(), [0], new AbortController().signal),
    ).rejects.toThrow('shutdown');
    await expect(
      sandbox.preview(createRequest(), [0], new AbortController().signal),
    ).rejects.toThrow('busy');
  });

  it.each(['symlink', 'oversized', 'badHeader', 'badGeometry'])(
    'rejects unsafe container output: %s',
    async (failure) => {
      const commands = createCommands();
      const normalRun = commands.run.getMockImplementation();
      if (!normalRun) {
        throw new Error('Command implementation absent.');
      }
      commands.run.mockImplementation((arguments_, options) => {
        const source = arguments_[5];
        if (arguments_[0] === 'exec' && source) {
          if (source.endsWith('.png') && failure === 'symlink') {
            expect(arguments_[4]).toContain('O_NOFOLLOW');
            return Promise.resolve({ exitCode: 1, stdout: '' });
          }
          if (source.endsWith('.png') && failure === 'oversized') {
            return Promise.resolve({
              exitCode: 0,
              stdout: Buffer.alloc(LessonCodeLimits.FRAME_BYTES + 1).toString('base64'),
            });
          }
          if (source.endsWith('.png') && failure === 'badHeader') {
            return Promise.resolve({
              exitCode: 0,
              stdout: Buffer.from('not a PNG').toString('base64'),
            });
          }
          if (source.endsWith('.json') && failure === 'badGeometry') {
            return Promise.resolve({
              exitCode: 0,
              stdout: Buffer.from(JSON.stringify([{ fontPx: null }])).toString('base64'),
            });
          }
        }
        return normalRun(arguments_, options);
      });
      await expect(
        new DockerLessonCodeSandbox({ commands }).preview(
          createRequest(),
          [0],
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(commands.run.mock.calls.at(-1)?.[0]?.slice(0, 2)).toEqual(['rm', '--force']);
    },
  );

  it('returns bounded compiler diagnostics for the coding agent to repair', async () => {
    const commands = createCommands();
    commands.run.mockImplementation((arguments_) => {
      if (arguments_[0] === 'exec') {
        if (arguments_[5]) {
          return Promise.resolve({
            exitCode: 0,
            stdout: Buffer.from(
              JSON.stringify({ stage: 'compile', message: 'Unexpected token at Scene.tsx:4' }),
            ).toString('base64'),
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: 'failed' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    });
    await expect(
      new DockerLessonCodeSandbox({ commands }).preview(
        createRequest(),
        [0],
        new AbortController().signal,
      ),
    ).rejects.toThrow('compile failed: Unexpected token at Scene.tsx:4');
  });

  it('returns a readable-shaped bad frame and its geometry for the coding agent to inspect and repair', async () => {
    const commands = createCommands();
    const normalRun = commands.run.getMockImplementation();
    if (!normalRun) {
      throw new Error('Command implementation absent.');
    }
    commands.run.mockImplementation((arguments_, options) =>
      arguments_[5]?.endsWith('.json')
        ? Promise.resolve({
            exitCode: 0,
            stdout: Buffer.from(JSON.stringify([{ ...Geometry[0], fontPx: 20 }])).toString(
              'base64',
            ),
          })
        : normalRun(arguments_, options),
    );
    const preview = await new DockerLessonCodeSandbox({ commands }).preview(
      createRequest(),
      [0],
      new AbortController().signal,
    );
    expect(preview.frames[0]?.geometry[0]?.fontPx).toBe(20);
    expect(preview.frames[0]?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('returns a blank preview so the repair agent sees the image before the encoder rejects its quality', async () => {
    const commands = createCommands();
    const normalRun = commands.run.getMockImplementation();
    if (!normalRun) {
      throw new Error('Command implementation absent.');
    }
    commands.run.mockImplementation((arguments_, options) =>
      arguments_[5]?.endsWith('.json')
        ? Promise.resolve({ exitCode: 0, stdout: Buffer.from('[]').toString('base64') })
        : normalRun(arguments_, options),
    );
    const preview = await new DockerLessonCodeSandbox({ commands }).preview(
      createRequest(),
      [0],
      new AbortController().signal,
    );
    expect(preview.frames[0]?.geometry).toEqual([]);
    expect(preview.frames[0]?.bytes.byteLength).toBeGreaterThan(0);
  });
});
