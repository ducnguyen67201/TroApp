import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatAuth } from '../../../../src/desktop/main/AgentChatPorts.js';
import { AgentTaskMode } from '../../../../src/contracts/CursorCompanion.js';
import {
  readEvaluationApplicationEnv,
  readEvaluationChildEnv,
} from '../../../../src/desktop/main/Env.js';
import {
  SignedInEvaluationFailure,
  SignedInEvaluationLimits,
  SignedInEvaluationApplication,
  runSignedInEvaluation,
  type EvaluationChildProcess,
  type EvaluationProcessLauncher,
  type SignedInEvaluationOptions,
} from '../../../../src/desktop/main/evaluation/RunSignedInEvaluation.js';

class TestEvaluationChild extends EventEmitter implements EvaluationChildProcess {
  endInput = vi.fn<EvaluationChildProcess['endInput']>();
  stop = vi.fn<EvaluationChildProcess['stop']>();

  onExit(receive: (code: number | null) => void): () => void {
    this.on('exit', receive);
    return () => {
      this.off('exit', receive);
    };
  }

  onError(receive: () => void): () => void {
    this.on('process-error', receive);
    return () => {
      this.off('process-error', receive);
    };
  }
}

function createFixture() {
  const child = new TestEvaluationChild();
  const launch = vi.fn<EvaluationProcessLauncher>().mockReturnValue(child);
  const readSession = vi.fn<AgentChatAuth['readSession']>().mockResolvedValue({
    kind: 'signed-in',
    user: {
      id: 'fixture-user',
      name: 'Fixture user',
      email: 'fixture@example.test',
      isAdmin: false,
    },
  });
  const credential = {
    token: 'opaque-synthetic-scoped-token',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  const fetchModelCredential = vi
    .fn<AgentChatAuth['fetchModelCredential']>()
    .mockResolvedValue(credential);
  const options = {
    auth: { readSession, fetchModelCredential },
    projectDirectory: '/synthetic/Tro',
    executablePath: '/synthetic/Tro.app/Contents/MacOS/Electron',
    gatewayBaseUrl: 'https://gateway.example.test/api/v1/model',
    childEnvironment: { PATH: '/synthetic/bin', HOME: '/synthetic/home' },
    launch,
  } satisfies SignedInEvaluationOptions;
  return { child, launch, readSession, fetchModelCredential, credential, options };
}

async function waitForLaunch(fixture: ReturnType<typeof createFixture>): Promise<void> {
  for (let turn = 0; turn < 6 && fixture.launch.mock.calls.length === 0; turn += 1) {
    await Promise.resolve();
  }
  expect(fixture.launch).toHaveBeenCalledOnce();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('signed-in development evaluation', () => {
  it('selects an automatic execute trial while keeping credentials on stdin', async () => {
    const fixture = createFixture();
    const running = runSignedInEvaluation({
      ...fixture.options,
      application: SignedInEvaluationApplication.VSCODE,
      taskMode: AgentTaskMode.EXECUTE,
      pricingFile: '/synthetic/Pricing.json',
    });
    await waitForLaunch(fixture);
    expect(fixture.launch.mock.calls[0]?.[1]).toContain('--execute');
    expect(fixture.launch.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['--pricing-file', '/synthetic/Pricing.json']),
    );
    expect(fixture.child.endInput).toHaveBeenCalledWith(JSON.stringify(fixture.credential));
    fixture.child.emit('exit', 0);
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
  });
  it('launches GUI applications with OS settings and excludes Node injection and provider credentials', () => {
    expect(
      readEvaluationApplicationEnv({
        PATH: '/synthetic/bin',
        HOME: '/synthetic/home',
        LANG: 'vi_VN.UTF-8',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require=private',
        OPENAI_API_KEY: 'synthetic-provider-key',
      }),
    ).toEqual({ PATH: '/synthetic/bin', HOME: '/synthetic/home', LANG: 'vi_VN.UTF-8' });
  });
  it('launches the fixed student Python case without changing credential delivery', async () => {
    const fixture = createFixture();
    const running = runSignedInEvaluation({
      ...fixture.options,
      application: SignedInEvaluationApplication.VSCODE,
    });
    await waitForLaunch(fixture);
    expect(fixture.launch.mock.calls[0]?.[1].slice(2, 5)).toEqual([
      '--single',
      '--application',
      'vscode',
    ]);
    expect(fixture.child.endInput).toHaveBeenCalledWith(JSON.stringify(fixture.credential));
    fixture.child.emit('exit', 0);
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
  });
  it('keeps the scoped credential on stdin and launches only the fixed single teaching trial', async () => {
    const fixture = createFixture();
    const running = runSignedInEvaluation(fixture.options);
    await waitForLaunch(fixture);
    const [executable, args, launchOptions] = fixture.launch.mock.calls[0] ?? [];
    expect(executable).toBe(fixture.options.executablePath);
    expect(args?.slice(0, 10)).toEqual([
      '/synthetic/Tro/node_modules/tsx/dist/cli.mjs',
      '/synthetic/Tro/scripts/RunInteractiveEvaluations.ts',
      '--single',
      '--application',
      'scratch',
      '--live',
      '--dedicated-desktop',
      '--credential-stdin',
      '--gateway',
      fixture.options.gatewayBaseUrl,
    ]);
    expect(args).not.toContain('--execute');
    expect(launchOptions).toEqual({
      cwd: '/synthetic/Tro',
      env: { PATH: '/synthetic/bin', HOME: '/synthetic/home', ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(fixture.child.endInput).toHaveBeenCalledWith(JSON.stringify(fixture.credential));
    expect(JSON.stringify(fixture.launch.mock.calls)).not.toContain(
      'opaque-synthetic-scoped-token',
    );
    fixture.child.emit('exit', 0);
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
    const result = await running;
    expect(result.outputDirectory).toMatch(
      /^\/synthetic\/Tro\/\.tro-development\/evaluations\/Interactive-signedin-/,
    );
    expect(fixture.child.listenerCount('exit')).toBe(0);
    expect(fixture.child.listenerCount('process-error')).toBe(0);
  });

  it('does not fetch a credential or start a child without a signed-in session', async () => {
    const fixture = createFixture();
    fixture.readSession.mockResolvedValue({ kind: 'signed-out' });
    await expect(runSignedInEvaluation(fixture.options)).rejects.toThrow(
      SignedInEvaluationFailure.SIGN_IN_REQUIRED,
    );
    expect(fixture.fetchModelCredential).not.toHaveBeenCalled();
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it('does not use a credential after the account changes while it is fetched', async () => {
    const fixture = createFixture();
    fixture.readSession.mockResolvedValueOnce({
      kind: 'signed-in',
      user: {
        id: 'fixture-user',
        name: 'Fixture user',
        email: 'fixture@example.test',
        isAdmin: false,
      },
    });
    fixture.readSession.mockResolvedValueOnce({
      kind: 'signed-in',
      user: {
        id: 'another-user',
        name: 'Another user',
        email: 'another@example.test',
        isAdmin: false,
      },
    });
    await expect(runSignedInEvaluation(fixture.options)).rejects.toThrow(
      SignedInEvaluationFailure.ACCOUNT_CHANGED,
    );
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it.each(['provider-key', 'expired'])(
    'rejects an unsuitable %s credential without spawning',
    async (kind) => {
      const fixture = createFixture();
      fixture.fetchModelCredential.mockResolvedValue({
        token: kind === 'provider-key' ? 'sk-synthetic-provider-key' : 'synthetic-expired-token',
        expiresAt: new Date(Date.now() + (kind === 'expired' ? -1 : 60_000)).toISOString(),
      });
      await expect(runSignedInEvaluation(fixture.options)).rejects.toThrow(
        SignedInEvaluationFailure.CREDENTIAL_UNAVAILABLE,
      );
      expect(fixture.launch).not.toHaveBeenCalled();
    },
  );

  it('cancels cooperatively and waits for confirmed child exit', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const running = runSignedInEvaluation({ ...fixture.options, signal: controller.signal });
    const rejected = expect(running).rejects.toThrow(SignedInEvaluationFailure.CANCELLED);
    await waitForLaunch(fixture);
    controller.abort();
    expect(fixture.child.stop).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(fixture.child.listenerCount('exit')).toBe(1);
    fixture.child.emit('exit', 0);
    await rejected;
    expect(fixture.child.listenerCount('exit')).toBe(0);
  });

  it('forces an unresponsive child to exit after its cooperative cleanup window', async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const controller = new AbortController();
    const running = runSignedInEvaluation({ ...fixture.options, signal: controller.signal });
    const rejected = expect(running).rejects.toThrow(SignedInEvaluationFailure.CANCELLED);
    await waitForLaunch(fixture);
    fixture.child.stop.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        fixture.child.emit('exit', null);
      }
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(SignedInEvaluationLimits.GRACEFUL_STOP_MS);
    await rejected;
    expect(fixture.child.stop.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unconfirmed cleanup without claiming a finished run', async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const running = runSignedInEvaluation(fixture.options);
    const rejected = expect(running).rejects.toThrow(SignedInEvaluationFailure.EXIT_UNCONFIRMED);
    await waitForLaunch(fixture);
    await vi.advanceTimersByTimeAsync(
      SignedInEvaluationLimits.RUN_MS +
        SignedInEvaluationLimits.GRACEFUL_STOP_MS +
        SignedInEvaluationLimits.FORCE_STOP_MS,
    );
    await rejected;
    expect(fixture.child.stop.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not launch when cancellation occurs during credential acquisition', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    fixture.fetchModelCredential.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        token: 'synthetic-cancelled-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    await expect(
      runSignedInEvaluation({ ...fixture.options, signal: controller.signal }),
    ).rejects.toThrow(SignedInEvaluationFailure.CANCELLED);
    expect(fixture.launch).not.toHaveBeenCalled();
  });
});

describe('evaluation child environment', () => {
  it('strips credentials and injection and fixes Electron Node mode without mutating its input', () => {
    const source = {
      PATH: '/synthetic/bin',
      HOME: '/synthetic/home',
      TMPDIR: '/synthetic/tmp',
      DISPLAY: ':17',
      LANG: 'en_US.UTF-8',
      NODE_OPTIONS: '--require=synthetic-injection',
      OPENAI_API_KEY: 'synthetic-key',
      AUTH_SECRET: 'synthetic-secret',
      ELECTRON_RUN_AS_NODE: '0',
    };
    const original = { ...source };
    expect(readEvaluationChildEnv(source)).toEqual({
      PATH: source.PATH,
      HOME: source.HOME,
      TMPDIR: source.TMPDIR,
      DISPLAY: source.DISPLAY,
      LANG: source.LANG,
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(source).toEqual(original);
  });

  it('keeps Windows startup paths but no unrelated private profile settings', () => {
    expect(
      readEvaluationChildEnv({
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temporary',
        TMP: 'C:\\Temporary',
        APPDATA: 'C:\\PrivateProfile',
        DATABASE_URL: 'synthetic-db-url',
      }),
    ).toEqual({
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temporary',
      TMP: 'C:\\Temporary',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it.each([{}, { PATH: '' }])('rejects missing executable search paths', (source) => {
    expect(() => readEvaluationChildEnv(source)).toThrow(
      'Evaluation child environment is invalid.',
    );
  });
});
