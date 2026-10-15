import type { execFile, ExecFileOptions } from 'node:child_process';
import type { setTimeout } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runMacCommand, type MacCommand } from '../../scripts/MacSigning.js';

const doubles = vi.hoisted(() => ({
  wait: vi.fn<typeof setTimeout>(),
  execute:
    vi.fn<
      (
        executable: string,
        arguments_: readonly string[],
        options: ExecFileOptions,
      ) => ReturnType<MacCommand>
    >(),
}));

vi.mock('node:timers/promises', async () => {
  const original =
    await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
  return { ...original, setTimeout: doubles.wait };
});

vi.mock('node:child_process', async () => {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return {
    ...original,
    execFile: Object.assign(vi.fn<typeof execFile>(), { [promisify.custom]: doubles.execute }),
  };
});

const privateMarker = 'private-command-value-never-log';
const FailureEventSchema = z.strictObject({
  event: z.literal('mac.release.command.failed'),
  tool: z.enum([
    'xcrun',
    'codesign',
    'security',
    'spctl',
    'plutil',
    'lipo',
    'otool',
    'ditto',
    'hdiutil',
    'node',
    'other',
  ]),
  operation: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().nonnegative(),
  reason: z.string(),
  urlErrorCode: z.number().int().nullable(),
});

const RetryEventSchema = z.strictObject({
  event: z.literal('mac.release.command.retry'),
  tool: z.literal('xcrun'),
  operation: z.enum(['stapler.validate', 'stapler.staple']),
  exitCode: z.literal(68),
  reason: z.literal('network-error'),
  urlErrorCode: z.number().int().nullable(),
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  nextAttempt: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  maxAttempts: z.literal(5),
  delayMs: z.union([z.literal(5000), z.literal(15000), z.literal(30000), z.literal(60000)]),
});

function readFailureEvent(): z.infer<typeof FailureEventSchema> {
  const calls = vi.mocked(console.error).mock.calls;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(1);
  const message = z.string().parse(calls[0]?.[0]);
  const raw: unknown = JSON.parse(message);
  expect(message).not.toContain(privateMarker);
  return FailureEventSchema.parse(raw);
}

function readRetryEvents(): z.infer<typeof RetryEventSchema>[] {
  return vi.mocked(console.warn).mock.calls.map((call) => {
    expect(call).toHaveLength(1);
    const message = z.string().parse(call[0]);
    const raw: unknown = JSON.parse(message);
    expect(message).not.toContain(privateMarker);
    return RetryEventSchema.parse(raw);
  });
}

beforeEach(() => {
  doubles.execute.mockReset();
  doubles.wait.mockReset();
  doubles.wait.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Mac command failure diagnostics', () => {
  it.each([
    ['Record not found', 'ticket-not-found'],
    ['Could not validate ticket', 'ticket-validation-failed'],
    ['does not have a ticket stapled', 'ticket-not-stapled'],
    ['NSURLErrorDomain', 'network-error'],
  ] as const)(
    'classifies stapler output containing %s without exposing it',
    async (phrase, reason) => {
      doubles.execute.mockRejectedValue(
        Object.assign(new Error(privateMarker), {
          code: 65,
          signal: null,
          stdout: `${privateMarker}\n${phrase}: /private/${privateMarker}/Tro.app`,
          stderr: `https://user:${privateMarker}@private.example.test`,
          cmd: `xcrun stapler validate /private/${privateMarker}/Tro.app`,
        }),
      );
      await expect(
        runMacCommand('/usr/bin/xcrun', [
          'stapler',
          'validate',
          `/private/${privateMarker}/Tro.app`,
        ]),
      ).rejects.toThrow(/^macOS release command failed: xcrun\.$/);
      expect(readFailureEvent()).toMatchObject({
        tool: 'xcrun',
        operation: 'stapler.validate',
        exitCode: 65,
        signal: null,
        reason,
      });
    },
  );

  it('classifies stapler stderr as well as stdout', async () => {
    doubles.execute.mockRejectedValue({
      code: 66,
      stderr: `${privateMarker}: does not have a ticket stapled`,
      stdout: '',
    });
    await expect(
      runMacCommand('/usr/bin/xcrun', ['stapler', 'staple', '/fixture.app']),
    ).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({
      operation: 'stapler.staple',
      exitCode: 66,
      reason: 'ticket-not-stapled',
    });
  });

  it.each([
    { stream: 'stdout', urlErrorCode: -1001 },
    { stream: 'stderr', urlErrorCode: -1200 },
  ])('reports only the numeric URL error from $stream', async ({ stream, urlErrorCode }) => {
    doubles.execute.mockRejectedValue({
      code: 65,
      [stream]: `NSURLErrorDomain Code=${String(urlErrorCode)} ${privateMarker}`,
    });
    await expect(
      runMacCommand('/usr/bin/xcrun', ['stapler', 'validate', '/fixture.app']),
    ).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({ reason: 'network-error', urlErrorCode });
  });

  it.each([
    'NSURLErrorDomain',
    'NSURLErrorDomain Code=1001',
    'NSURLErrorDomain Code="-1001"',
    'NSURLErrorDomain Code=-1234567',
    'NSURLErrorDomain Code=-1.5',
    'NSURLErrorDomain Code=-1001suffix',
    'OtherDomain Code=-1001 NSURLErrorDomain',
    `${'x'.repeat(16_384)} NSURLErrorDomain Code=-1001`,
  ])('does not report a missing, malformed or out-of-bounds URL code: %#', async (output) => {
    doubles.execute.mockRejectedValue({ code: 65, stderr: `${output} ${privateMarker}` });
    await expect(
      runMacCommand('/usr/bin/xcrun', ['stapler', 'validate', '/fixture.app']),
    ).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({ urlErrorCode: null });
  });

  it('omits numeric URL evidence when a permanent ticket failure takes precedence', async () => {
    doubles.execute.mockRejectedValue({
      code: 68,
      stderr: `Record not found NSURLErrorDomain Code=-1200 ${privateMarker}`,
    });
    await expect(
      runMacCommand('/usr/bin/xcrun', ['stapler', 'validate', '/fixture.app']),
    ).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({
      reason: 'ticket-not-found',
      urlErrorCode: null,
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['/usr/bin/xcrun', ['notarytool', 'submit'], 'notarytool.submit'],
    ['/usr/bin/xcrun', ['notarytool', 'info'], 'notarytool.info'],
    ['/usr/bin/xcrun', ['notarytool', 'log'], 'notarytool.log'],
    ['/usr/bin/codesign', ['--verify'], 'codesign.verify'],
    ['/usr/bin/codesign', ['--display'], 'codesign.display'],
    ['/usr/bin/codesign', ['--force', '--sign'], 'codesign.sign'],
    ['/usr/bin/security', ['find-identity'], 'security.find-identity'],
    ['/usr/bin/plutil', ['-extract'], 'plutil.extract'],
    ['/usr/bin/lipo', ['-archs'], 'lipo.archs'],
    ['/usr/sbin/spctl', ['--assess'], 'spctl.assess'],
    ['/usr/bin/otool', ['-l'], 'other'],
    ['/usr/bin/ditto', ['-x'], 'other'],
    ['/usr/bin/hdiutil', ['attach'], 'other'],
    ['/usr/bin/node', ['-e'], 'other'],
  ] as const)(
    'reports only the approved operation for %s %s',
    async (executable, arguments_, operation) => {
      doubles.execute.mockRejectedValue({
        code: 1,
        stderr: `NSURLErrorDomain ${privateMarker}`,
        message: privateMarker,
      });
      await expect(
        runMacCommand(executable, [...arguments_, '--password', privateMarker]),
      ).rejects.toThrow();
      expect(readFailureEvent()).toMatchObject({ operation, exitCode: 1, reason: 'unknown' });
    },
  );

  it('distinguishes missing executables from terminated commands without inferring a timeout', async () => {
    doubles.execute.mockRejectedValueOnce({ code: 'ENOENT', message: privateMarker });
    await expect(
      runMacCommand('/usr/bin/xcrun', ['stapler', 'validate', '/fixture.app']),
    ).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({
      exitCode: null,
      signal: null,
      reason: 'executable-not-found',
    });
    vi.mocked(console.error).mockClear();
    doubles.execute.mockRejectedValueOnce({
      code: null,
      signal: 'SIGTERM',
      killed: true,
      stderr: privateMarker,
    });
    await expect(
      runMacCommand('/usr/bin/xcrun', ['stapler', 'validate', '/fixture.app']),
    ).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
      reason: 'terminated',
    });
  });

  it.each([
    undefined,
    null,
    privateMarker,
    { code: privateMarker, signal: privateMarker, killed: privateMarker },
    { code: Number.NaN, signal: { secret: privateMarker }, stderr: { secret: privateMarker } },
    { code: Number.POSITIVE_INFINITY, stdout: [privateMarker] },
    { code: 1.5, stderr: Buffer.from(privateMarker) },
  ])('keeps malformed rejection fields out of diagnostics: %#', async (failure: unknown) => {
    doubles.execute.mockRejectedValue(failure);
    await expect(runMacCommand(`/private/${privateMarker}`, [privateMarker])).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({
      tool: 'other',
      operation: 'other',
      exitCode: null,
      signal: null,
      reason: 'unknown',
    });
  });

  it('does not classify familiar failure text for an unknown xcrun operation', async () => {
    doubles.execute.mockRejectedValue({ code: 1, stderr: `Record not found ${privateMarker}` });
    await expect(runMacCommand('/usr/bin/xcrun', [privateMarker, 'validate'])).rejects.toThrow();
    expect(readFailureEvent()).toMatchObject({
      tool: 'xcrun',
      operation: 'other',
      reason: 'unknown',
    });
  });

  it('returns successful output without producing failure diagnostics and retains execution bounds', async () => {
    const output = { stdout: privateMarker, stderr: 'tool warning' };
    doubles.execute.mockResolvedValue(output);
    await expect(
      runMacCommand('/usr/bin/xcrun', ['stapler', 'validate', '/fixture.app']),
    ).resolves.toEqual(output);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(doubles.wait).not.toHaveBeenCalled();
    expect(doubles.execute).toHaveBeenCalledWith(
      '/usr/bin/xcrun',
      ['stapler', 'validate', '/fixture.app'],
      expect.objectContaining({ timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }),
    );
  });
});

describe.each(['validate', 'staple'])('Mac stapler %s retries', (action) => {
  const arguments_ = ['stapler', action, `/private/${privateMarker}/Tro.app`];
  const transientFailure = {
    code: 68,
    signal: null,
    killed: false,
    message: privateMarker,
    stdout: `/private/${privateMarker}/Tro.app`,
    stderr: `NSURLErrorDomain https://user:${privateMarker}@private.example.test`,
  };
  const expectedRetries = [
    {
      event: 'mac.release.command.retry',
      tool: 'xcrun',
      operation: `stapler.${action}`,
      exitCode: 68,
      reason: 'network-error',
      urlErrorCode: null,
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 5,
      delayMs: 5000,
    },
    {
      event: 'mac.release.command.retry',
      tool: 'xcrun',
      operation: `stapler.${action}`,
      exitCode: 68,
      reason: 'network-error',
      urlErrorCode: null,
      attempt: 2,
      nextAttempt: 3,
      maxAttempts: 5,
      delayMs: 15000,
    },
    {
      event: 'mac.release.command.retry',
      tool: 'xcrun',
      operation: `stapler.${action}`,
      exitCode: 68,
      reason: 'network-error',
      urlErrorCode: null,
      attempt: 3,
      nextAttempt: 4,
      maxAttempts: 5,
      delayMs: 30000,
    },
    {
      event: 'mac.release.command.retry',
      tool: 'xcrun',
      operation: `stapler.${action}`,
      exitCode: 68,
      reason: 'network-error',
      urlErrorCode: null,
      attempt: 4,
      nextAttempt: 5,
      maxAttempts: 5,
      delayMs: 60000,
    },
  ];

  it.each([1, 2, 3, 4])(
    'recovers after %i network failures without logging a terminal error',
    async (failures) => {
      for (let index = 0; index < failures; index += 1) {
        doubles.execute.mockRejectedValueOnce(transientFailure);
      }
      const output = { stdout: 'validated', stderr: '' };
      doubles.execute.mockResolvedValueOnce(output);
      doubles.wait.mockImplementation(() => {
        expect(console.error).not.toHaveBeenCalled();
        return Promise.resolve();
      });

      await expect(runMacCommand('/usr/bin/xcrun', arguments_)).resolves.toEqual(output);
      expect(doubles.execute).toHaveBeenCalledTimes(failures + 1);
      for (const call of doubles.execute.mock.calls) {
        expect(call).toEqual([
          '/usr/bin/xcrun',
          arguments_,
          expect.objectContaining({ timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }),
        ]);
      }
      expect(doubles.wait.mock.calls).toEqual(
        [[5000], [15000], [30000], [60000]].slice(0, failures),
      );
      expect(readRetryEvents()).toEqual(expectedRetries.slice(0, failures));
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it('fails closed after five attempts with four safe retry events and one final failure', async () => {
    doubles.execute.mockRejectedValue(transientFailure);
    doubles.wait.mockImplementation(() => {
      expect(console.error).not.toHaveBeenCalled();
      return Promise.resolve();
    });
    await expect(runMacCommand('/usr/bin/xcrun', arguments_)).rejects.toThrow(
      /^macOS release command failed: xcrun\.$/,
    );
    expect(doubles.execute).toHaveBeenCalledTimes(5);
    expect(doubles.wait.mock.calls).toEqual([[5000], [15000], [30000], [60000]]);
    expect(readRetryEvents()).toEqual(expectedRetries);
    expect(readFailureEvent()).toMatchObject({
      tool: 'xcrun',
      operation: `stapler.${action}`,
      exitCode: 68,
      signal: null,
      reason: 'network-error',
      urlErrorCode: null,
    });
  });

  it.each([
    { stream: 'stdout', urlErrorCode: -1001 },
    { stream: 'stderr', urlErrorCode: -1005 },
    { stream: 'stderr', urlErrorCode: -1200 },
  ])(
    'includes only the numeric URL error in a retry from $stream',
    async ({ stream, urlErrorCode }) => {
      doubles.execute
        .mockRejectedValueOnce({
          ...transientFailure,
          [stream]: `NSURLErrorDomain Code=${String(urlErrorCode)} ${privateMarker}`,
        })
        .mockResolvedValueOnce({ stdout: 'validated', stderr: '' });
      await expect(runMacCommand('/usr/bin/xcrun', arguments_)).resolves.toEqual({
        stdout: 'validated',
        stderr: '',
      });
      expect(readRetryEvents()).toEqual([{ ...expectedRetries[0], urlErrorCode }]);
      expect(doubles.wait.mock.calls).toEqual([[5000]]);
      expect(doubles.execute).toHaveBeenCalledTimes(2);
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it('stops immediately when a retry encounters a permanent ticket failure', async () => {
    doubles.execute.mockRejectedValueOnce(transientFailure).mockRejectedValueOnce({
      ...transientFailure,
      stderr: `Record not found NSURLErrorDomain ${privateMarker}`,
    });
    await expect(runMacCommand('/usr/bin/xcrun', arguments_)).rejects.toThrow();
    expect(doubles.execute).toHaveBeenCalledTimes(2);
    expect(doubles.wait.mock.calls).toEqual([[5000]]);
    expect(readRetryEvents()).toEqual(expectedRetries.slice(0, 1));
    expect(readFailureEvent()).toMatchObject({ reason: 'ticket-not-found' });
  });

  it.each([
    ['/usr/bin/xcrun', ['notarytool', 'submit'], 'notarytool.submit'],
    ['/usr/bin/xcrun', ['notarytool', 'info'], 'notarytool.info'],
    ['/usr/bin/codesign', ['--verify'], 'codesign.verify'],
    ['/usr/bin/other', ['stapler', 'validate'], 'other'],
  ] as const)(
    'never repeats other commands: %s %s',
    async (executable, commandArguments, operation) => {
      doubles.execute.mockRejectedValue(transientFailure);
      await expect(
        runMacCommand(executable, [...commandArguments, privateMarker]),
      ).rejects.toThrow();
      expect(doubles.execute).toHaveBeenCalledTimes(1);
      expect(doubles.wait).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(readFailureEvent()).toMatchObject({ operation });
    },
  );

  it.each([
    { name: 'other exit code', overrides: { code: 65 }, reason: 'network-error' },
    { name: 'missing-input exit code', overrides: { code: 66 }, reason: 'network-error' },
    { name: 'revoked-ticket exit code', overrides: { code: 77 }, reason: 'network-error' },
    { name: 'string exit code', overrides: { code: '68' }, reason: 'network-error' },
    { name: 'unknown failure', overrides: { stderr: privateMarker }, reason: 'unknown' },
    { name: 'termination', overrides: { killed: true }, reason: 'terminated' },
    { name: 'termination signal', overrides: { signal: 'SIGTERM' }, reason: 'network-error' },
    { name: 'unrecognized signal', overrides: { signal: privateMarker }, reason: 'network-error' },
    {
      name: 'missing ticket',
      overrides: { stderr: `Record not found ${privateMarker}` },
      reason: 'ticket-not-found',
    },
  ])('does not retry $name', async ({ overrides, reason }) => {
    doubles.execute.mockRejectedValue({ ...transientFailure, ...overrides });
    await expect(runMacCommand('/usr/bin/xcrun', arguments_)).rejects.toThrow();
    expect(doubles.execute).toHaveBeenCalledTimes(1);
    expect(doubles.wait).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(readFailureEvent()).toMatchObject({ reason });
  });

  it.each([
    ['Record not found', 'ticket-not-found'],
    ['does not have a ticket stapled', 'ticket-not-stapled'],
  ] as const)(
    'gives permanent ticket evidence precedence over network text: %s',
    async (phrase, reason) => {
      doubles.execute.mockRejectedValue({
        ...transientFailure,
        stdout: `NSURLErrorDomain ${privateMarker}`,
        stderr: `${phrase} ${privateMarker}`,
      });
      await expect(runMacCommand('/usr/bin/xcrun', arguments_)).rejects.toThrow();
      expect(doubles.execute).toHaveBeenCalledTimes(1);
      expect(doubles.wait).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(readFailureEvent()).toMatchObject({ reason });
    },
  );

  it('retries network failure accompanied by generic ticket-validation text', async () => {
    doubles.execute
      .mockRejectedValueOnce({
        ...transientFailure,
        stdout: `Could not validate ticket ${privateMarker}`,
      })
      .mockResolvedValueOnce({ stdout: 'validated', stderr: '' });
    await expect(runMacCommand('/usr/bin/xcrun', arguments_)).resolves.toEqual({
      stdout: 'validated',
      stderr: '',
    });
    expect(doubles.execute).toHaveBeenCalledTimes(2);
    expect(doubles.wait.mock.calls).toEqual([[5000]]);
    expect(readRetryEvents()).toEqual(expectedRetries.slice(0, 1));
    expect(console.error).not.toHaveBeenCalled();
  });
});
