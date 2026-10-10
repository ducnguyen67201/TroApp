import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LessonCodeFailureSchema,
  LessonCodeLimits,
  LessonCodeMode,
  LessonCodePreviewGeometrySchema,
  LessonCodeRequestSchema,
  LessonCodeSandboxError,
  LessonCodeWorkerInputSchema,
  type LessonCodePreview,
  type LessonCodeRequest,
  type LessonCodeSandbox,
} from './LessonCodeSandbox.js';
import { validateLessonSource } from './ValidateLessonSource.js';

export interface LessonDockerCommandOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface LessonDockerCommands {
  run(
    arguments_: readonly string[],
    options: LessonDockerCommandOptions,
  ): Promise<{ exitCode: number; stdout: string }>;
}

export interface DockerLessonCodeSandboxOptions {
  image?: string;
  commands?: LessonDockerCommands;
  deadlineMs?: number;
}

/**
 * Docker is the execution boundary, not Node's VM or a host Chromium process.
 * Only two fixed input files enter the container. Writable output and scratch mounts
 * have Docker-enforced size limits; generated source never receives a host writable mount.
 */
export class DockerLessonCodeSandbox implements LessonCodeSandbox {
  private readonly image: string;
  private readonly commands: LessonDockerCommands;
  private readonly deadlineMs: number;
  private active = false;

  constructor(configuration: DockerLessonCodeSandboxOptions | string = {}) {
    const options = typeof configuration === 'string' ? { image: configuration } : configuration;
    this.image = options.image ?? 'tro-lesson-renderer:local';
    if (!/^[a-z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(this.image)) {
      throw new Error('The lesson renderer image is invalid.');
    }
    this.commands = options.commands ?? new NodeLessonDockerCommands();
    this.deadlineMs = options.deadlineMs ?? LessonCodeLimits.DEADLINE_MS;
    if (
      !Number.isSafeInteger(this.deadlineMs) ||
      this.deadlineMs < 1 ||
      this.deadlineMs > LessonCodeLimits.DEADLINE_MS
    ) {
      throw new Error('The lesson render deadline is invalid.');
    }
  }

  /** Verify the local isolation prerequisite before the workflow spends model or speech usage. */
  async checkReady(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active) {
      throw new Error('Generated lesson rendering is busy or awaits confirmed shutdown.');
    }
    const options = { signal, timeoutMs: 10_000, maxOutputBytes: 4096 };
    let host: Awaited<ReturnType<LessonDockerCommands['run']>>;
    let image: Awaited<ReturnType<LessonDockerCommands['run']>>;
    try {
      host = await this.commands.run(['info', '--format', '{{.OSType}}'], options);
      image = await this.commands.run(
        ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', this.image],
        options,
      );
    } catch {
      signal.throwIfAborted();
      throw new Error(
        'Generated lessons require an available Docker daemon and the built Linux AMD64 render image.',
      );
    }
    signal.throwIfAborted();
    if (host.exitCode !== 0 || host.stdout.trim() !== 'linux') {
      throw new Error('Generated lessons require a Docker daemon running Linux containers.');
    }
    if (image.exitCode !== 0 || image.stdout.trim() !== 'linux/amd64') {
      throw new Error(
        'Build the Linux AMD64 lesson render image before starting generation; the renderer never pulls images.',
      );
    }
  }

  async preview(
    request: LessonCodeRequest,
    frames: number[],
    signal: AbortSignal,
  ): Promise<LessonCodePreview> {
    return this.runContainer(request, LessonCodeMode.PREVIEW, frames, signal, async (copy) => {
      const rendered: LessonCodePreview['frames'] = [];
      for (const frame of frames) {
        const bytes = await copy(`Frame${String(frame)}.png`, LessonCodeLimits.FRAME_BYTES);
        if (!hasPngHeader(bytes)) {
          throw new Error('Generated lesson preview is not a PNG image.');
        }
        const raw: unknown = JSON.parse(
          new TextDecoder().decode(
            await copy(`Geometry${String(frame)}.json`, LessonCodeLimits.GEOMETRY_BYTES),
          ),
        );
        rendered.push({ frame, bytes, geometry: LessonCodePreviewGeometrySchema.parse(raw) });
      }
      return { frames: rendered };
    });
  }

  async renderVideo(request: LessonCodeRequest, signal: AbortSignal): Promise<Uint8Array> {
    return this.runContainer(request, LessonCodeMode.VIDEO, [], signal, async (copy) => {
      const bytes = await copy('Video.mp4', LessonCodeLimits.VIDEO_BYTES);
      if (bytes.byteLength < 12 || Buffer.from(bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') {
        throw new Error('Generated lesson render is not an MP4 video.');
      }
      return bytes;
    });
  }

  private async runContainer<Result>(
    request: LessonCodeRequest,
    mode: (typeof LessonCodeMode)[keyof typeof LessonCodeMode],
    frames: number[],
    signal: AbortSignal,
    readResult: (
      copy: (name: string, maximumBytes: number) => Promise<Uint8Array>,
    ) => Promise<Result>,
  ): Promise<Result> {
    if (this.active || signal.aborted) {
      throw new Error('Generated lesson rendering is busy or cancelled.');
    }
    const validated = LessonCodeRequestSchema.parse(request);
    validateLessonSource(validated.source);
    const input = LessonCodeWorkerInputSchema.parse({
      projection: validated.projection,
      durationInFrames: validated.durationInFrames,
      mode,
      frames,
    });
    this.active = true;
    let directory: string;
    try {
      directory = await mkdtemp(join(tmpdir(), 'tro-lesson-code-'));
    } catch (error) {
      this.active = false;
      throw error;
    }
    const inputDirectory = join(directory, 'input');
    const outputDirectory = join(directory, 'output');
    const name = `tro-lesson-${randomUUID()}`;
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(cancel, this.deadlineMs);
    let containerStarted = false;
    let removed = false;
    try {
      /* Docker --mount parses commas. Temporary path syntax cannot become mount options. */
      if (/[,:\r\n]/.test(inputDirectory)) {
        throw new Error('The temporary lesson input directory cannot be mounted safely.');
      }
      await mkdir(inputDirectory);
      await mkdir(outputDirectory);
      await writeFile(join(inputDirectory, 'Scene.tsx'), validated.source, { mode: 0o444 });
      await writeFile(join(inputDirectory, 'Input.json'), JSON.stringify(input), { mode: 0o444 });
      await chmod(inputDirectory, 0o555);
      signal.throwIfAborted();
      containerStarted = true;
      const result = await this.commands.run(
        buildContainerArguments(name, this.image, inputDirectory),
        {
          signal: controller.signal,
          timeoutMs: this.deadlineMs,
          maxOutputBytes: 65_536,
        },
      );
      const copy = async (fileName: string, maximumBytes: number): Promise<Uint8Array> => {
        controller.signal.throwIfAborted();
        const destination = join(outputDirectory, fileName);
        const copied = await this.commands.run(
          [
            'exec',
            name,
            'node',
            '-e',
            ReadOutputProgram,
            `/render/output/${fileName}`,
            String(maximumBytes),
          ],
          {
            signal: controller.signal,
            timeoutMs: 10_000,
            maxOutputBytes: Math.ceil(maximumBytes / 3) * 4 + 4096,
          },
        );
        if (copied.exitCode !== 0) {
          throw new Error('Generated lesson output is incomplete.');
        }
        if (
          copied.stdout.length > Math.ceil(maximumBytes / 3) * 4 ||
          copied.stdout.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(copied.stdout)
        ) {
          throw new Error('Generated lesson output exceeds its transfer contract.');
        }
        const bytes = Buffer.from(copied.stdout, 'base64');
        if (
          bytes.byteLength < 1 ||
          bytes.byteLength > maximumBytes ||
          bytes.toString('base64') !== copied.stdout
        ) {
          throw new Error('Generated lesson output exceeds its transfer contract.');
        }
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        return readBoundedFile(destination, maximumBytes);
      };
      controller.signal.throwIfAborted();
      if (result.exitCode !== 0) {
        throw new Error('The isolated lesson renderer could not start.');
      }
      /* Keep the container alive until fixed files have been copied from its bounded tmpfs. */
      const ready = await this.commands.run(
        [
          'exec',
          name,
          'node',
          '-e',
          'const fs=require("node:fs");const timer=setInterval(()=>{try{const value=fs.readFileSync("/render/output/Ready.txt","utf8");if(value==="ready"||value==="failed"){clearInterval(timer);process.stdout.write(value);}}catch{}},100);',
        ],
        { signal: controller.signal, timeoutMs: this.deadlineMs, maxOutputBytes: 4096 },
      );
      if (ready.exitCode !== 0 || ready.stdout !== 'ready') {
        let failureError: Error = new Error('Generated lesson compilation or rendering failed.');
        try {
          const raw: unknown = JSON.parse(
            new TextDecoder().decode(await copy('Failure.json', 16_384)),
          );
          const failure = LessonCodeFailureSchema.parse(raw);
          failureError = new LessonCodeSandboxError(
            failure.stage,
            `Generated lesson ${failure.stage} failed: ${failure.message}`,
          );
        } catch {
          /* Startup/resource failures may occur before the worker can produce a diagnostic. */
        }
        throw failureError;
      }
      return await readResult(copy);
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', cancel);
      try {
        if (containerStarted) {
          await this.removeContainerAndConfirmShutdown(name);
          removed = true;
        } else {
          removed = true;
        }
      } finally {
        await chmod(inputDirectory, 0o755).catch(() => {});
        await rm(directory, { recursive: true, force: true });
        if (removed) {
          this.active = false;
        }
      }
    }
  }

  private async removeContainerAndConfirmShutdown(name: string): Promise<void> {
    const cleanup = await this.commands.run(['rm', '--force', name], {
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    if (cleanup.exitCode === 0) {
      return;
    }
    const remaining = await this.commands.run(
      ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
      { timeoutMs: 10_000, maxOutputBytes: 4096 },
    );
    if (remaining.exitCode !== 0 || remaining.stdout.trim() !== '') {
      throw new Error('Lesson container shutdown could not be confirmed. Restart the renderer.');
    }
  }
}

/** Docker's archive API cannot read tmpfs mounts. Read only one fixed bounded regular file inside the container. */
const ReadOutputProgram = `
const fs=require('node:fs');
const file=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{
  const info=fs.fstatSync(file),maximum=Number(process.argv[2]);
  if(!info.isFile()||info.nlink!==1||info.size<1||info.size>maximum)throw new Error('Invalid bounded output file.');
  const bytes=Buffer.alloc(info.size);let offset=0;
  while(offset<bytes.length){const count=fs.readSync(file,bytes,offset,bytes.length-offset,offset);if(count<1)throw new Error('Truncated output.');offset+=count;}
  process.stdout.write(bytes.toString('base64'));
}finally{fs.closeSync(file);}
`;

function buildContainerArguments(name: string, image: string, inputDirectory: string): string[] {
  return [
    'run',
    '--detach',
    '--init',
    '--rm',
    '--pull',
    'never',
    '--name',
    name,
    '--platform',
    'linux/amd64',
    '--network',
    'none',
    '--read-only',
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
    '--ulimit',
    `fsize=${String(LessonCodeLimits.VIDEO_BYTES)}:${String(LessonCodeLimits.VIDEO_BYTES)}`,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=536870912,mode=1777',
    '--tmpfs',
    '/dev/shm:rw,nosuid,nodev,noexec,size=268435456,mode=1777',
    '--mount',
    `type=bind,src=${inputDirectory},dst=/render/input,readonly`,
    '--mount',
    'type=tmpfs,dst=/render/output,tmpfs-size=201326592,tmpfs-mode=1777',
    '--workdir',
    '/app',
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
    '--entrypoint',
    'node',
    image,
    '--max-old-space-size=1024',
    'dist/server/features/guidedLessons/infrastructure/RenderGeneratedLessonWorker.js',
  ];
}

/** Open without following symlinks, then validate the same descriptor used for the bounded read. */
async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new Error('Generated lesson output is not a bounded regular file.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== info.size || opened.nlink !== 1) {
      throw new Error('Generated lesson output changed before reading.');
    }
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await file.read(buffer, 0, opened.size, 0);
    if (bytesRead !== opened.size) {
      throw new Error('Generated lesson output was truncated.');
    }
    return buffer;
  } finally {
    await file.close();
  }
}

function hasPngHeader(bytes: Uint8Array): boolean {
  const header = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length > header.length && header.every((value, index) => bytes[index] === value);
}

export class NodeLessonDockerCommands implements LessonDockerCommands {
  run(
    arguments_: readonly string[],
    options: LessonDockerCommandOptions,
  ): Promise<{ exitCode: number; stdout: string }> {
    return new Promise((fulfill, reject) => {
      const child = spawn('docker', [...arguments_], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let outputBytes = 0;
      let failure: Error | undefined;
      const stop = (): void => {
        failure = new Error('The lesson Docker command was cancelled or exceeded its deadline.');
        child.kill('SIGKILL');
      };
      const timer = setTimeout(stop, options.timeoutMs);
      options.signal?.addEventListener('abort', stop, { once: true });
      const collect = (chunk: unknown, isStdout: boolean): void => {
        if (!(chunk instanceof Uint8Array)) {
          stop();
          return;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes > options.maxOutputBytes) {
          stop();
          return;
        }
        if (isStdout) {
          stdout += Buffer.from(chunk).toString('utf8');
        }
      };
      child.stdout.on('data', (chunk: unknown) => {
        collect(chunk, true);
      });
      child.stderr.on('data', (chunk: unknown) => {
        collect(chunk, false);
      });
      child.once('error', () => {
        failure = new Error('Docker could not start the lesson renderer.');
      });
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', stop);
        if (failure) {
          reject(failure);
        } else {
          fulfill({ exitCode: exitCode ?? 1, stdout });
        }
      });
      if (options.signal?.aborted) {
        stop();
      }
    });
  }
}
