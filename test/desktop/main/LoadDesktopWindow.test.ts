import { describe, expect, it, vi } from 'vitest';
import {
  DesktopWindowLoadPolicy,
  DesktopWindowSource,
  loadDesktopWindow,
  readDesktopChildFailure,
  type DesktopWindowLoadDiagnostic,
} from '../../../src/desktop/main/LoadDesktopWindow.js';

function createLoadFailure(code = 'ERR_FAILED'): Error {
  return Object.assign(
    new Error('Sensitive URL, profile or configuration must stay out of logs.'),
    {
      code,
      errno: -2,
      url: 'https://private.example.test/?token=private-value',
    },
  );
}

function createFixture(
  source:
    | typeof DesktopWindowSource.DEVELOPMENT
    | typeof DesktopWindowSource.PACKAGED = DesktopWindowSource.DEVELOPMENT,
) {
  const diagnostics: DesktopWindowLoadDiagnostic[] = [];
  const state = { networkFailureVersion: 0, canContinue: true };
  const load = vi.fn<() => Promise<void>>().mockResolvedValue();
  const pause = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
  const options = {
    source,
    load,
    readNetworkFailureVersion: () => state.networkFailureVersion,
    canContinue: () => state.canContinue,
    log: (diagnostic: DesktopWindowLoadDiagnostic) => {
      diagnostics.push(diagnostic);
    },
    pause,
    now: () => 10,
  };
  return { options, state, load, pause, diagnostics };
}

describe('desktop window startup', () => {
  it('loads a healthy renderer once without diagnostics or delay', async () => {
    const fixture = createFixture();
    await loadDesktopWindow(fixture.options);
    expect(fixture.load).toHaveBeenCalledOnce();
    expect(fixture.pause).not.toHaveBeenCalled();
    expect(fixture.diagnostics).toEqual([]);
  });

  it('recovers when the Network Service exits during the initial development load', async () => {
    const fixture = createFixture();
    fixture.load.mockImplementationOnce(() => {
      fixture.state.networkFailureVersion += 1;
      return Promise.reject(createLoadFailure());
    });
    await loadDesktopWindow(fixture.options);
    expect(fixture.load).toHaveBeenCalledTimes(2);
    expect(fixture.pause).toHaveBeenCalledExactlyOnceWith(DesktopWindowLoadPolicy.RETRY_DELAY_MS);
    expect(fixture.diagnostics).toEqual([
      {
        event: 'desktop.renderer.load.failed',
        source: DesktopWindowSource.DEVELOPMENT,
        attempt: 1,
        code: 'ERR_FAILED',
        durationMs: 0,
        willRetry: true,
      },
      {
        event: 'desktop.renderer.load.recovered',
        source: DesktopWindowSource.DEVELOPMENT,
        attempt: 2,
        durationMs: 0,
      },
    ]);
    expect(JSON.stringify(fixture.diagnostics)).not.toMatch(/private|Sensitive|token/);
  });

  it('bounds repeated Network Service failures and propagates the final error', async () => {
    const fixture = createFixture();
    const failure = createLoadFailure();
    fixture.load.mockImplementation(() => {
      fixture.state.networkFailureVersion += 1;
      return Promise.reject(failure);
    });
    await expect(loadDesktopWindow(fixture.options)).rejects.toBe(failure);
    expect(fixture.load).toHaveBeenCalledTimes(DesktopWindowLoadPolicy.MAX_ATTEMPTS);
    expect(fixture.pause).toHaveBeenCalledTimes(DesktopWindowLoadPolicy.MAX_ATTEMPTS - 1);
    expect(fixture.diagnostics.at(-1)).toMatchObject({ willRetry: false, attempt: 3 });
  });

  it.each(['ERR_FAILED', 'ERR_CONNECTION_REFUSED', 'ERR_ABORTED'])(
    'does not retry %s without an observed Network Service failure',
    async (code) => {
      const fixture = createFixture();
      fixture.state.networkFailureVersion = 4;
      const failure = createLoadFailure(code);
      fixture.load.mockRejectedValue(failure);
      await expect(loadDesktopWindow(fixture.options)).rejects.toBe(failure);
      expect(fixture.load).toHaveBeenCalledOnce();
      expect(fixture.pause).not.toHaveBeenCalled();
    },
  );

  it.each(['ERR_ABORTED', 'ERR_CONNECTION_REFUSED', 'credential-private-value'])(
    'keeps unrelated %s failures terminal even alongside a Network Service exit',
    async (code) => {
      const fixture = createFixture();
      const failure = createLoadFailure(code);
      fixture.load.mockImplementation(() => {
        fixture.state.networkFailureVersion += 1;
        return Promise.reject(failure);
      });
      await expect(loadDesktopWindow(fixture.options)).rejects.toBe(failure);
      expect(fixture.load).toHaveBeenCalledOnce();
      expect(fixture.pause).not.toHaveBeenCalled();
      expect(JSON.stringify(fixture.diagnostics)).not.toContain('private-value');
    },
  );

  it('does not retry packaged renderer failures', async () => {
    const fixture = createFixture(DesktopWindowSource.PACKAGED);
    const failure = createLoadFailure();
    fixture.load.mockImplementation(() => {
      fixture.state.networkFailureVersion += 1;
      return Promise.reject(failure);
    });
    await expect(loadDesktopWindow(fixture.options)).rejects.toBe(failure);
    expect(fixture.load).toHaveBeenCalledOnce();
  });

  it('does not retry during shutdown or after window destruction', async () => {
    const fixture = createFixture();
    const failure = createLoadFailure();
    fixture.load.mockImplementation(() => {
      fixture.state.networkFailureVersion += 1;
      fixture.state.canContinue = false;
      return Promise.reject(failure);
    });
    await expect(loadDesktopWindow(fixture.options)).rejects.toBe(failure);
    expect(fixture.pause).not.toHaveBeenCalled();
    expect(fixture.load).toHaveBeenCalledOnce();
  });

  it('rechecks window lifetime after the retry delay', async () => {
    const fixture = createFixture();
    const failure = createLoadFailure();
    fixture.load.mockImplementationOnce(() => {
      fixture.state.networkFailureVersion += 1;
      return Promise.reject(failure);
    });
    fixture.pause.mockImplementation(() => {
      fixture.state.canContinue = false;
      return Promise.resolve();
    });
    await expect(loadDesktopWindow(fixture.options)).rejects.toBe(failure);
    expect(fixture.load).toHaveBeenCalledOnce();
  });
});

describe('desktop child failure diagnostics', () => {
  it('classifies the Network Service without logging arbitrary child names', () => {
    expect(
      readDesktopChildFailure({
        type: 'Utility',
        reason: 'killed',
        exitCode: 15,
        serviceName: 'network.mojom.NetworkService',
        name: 'private-child-name',
      }),
    ).toEqual({
      event: 'desktop.child_process.failed',
      processType: 'Utility',
      reason: 'killed',
      exitCode: 15,
      isNetworkService: true,
    });
    const diagnostic = readDesktopChildFailure({
      type: 'Utility',
      reason: 'crashed',
      exitCode: 1,
      serviceName: 'private-service-name',
      name: 'private-child-name',
    });
    expect(diagnostic?.isNetworkService).toBe(false);
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    expect(
      readDesktopChildFailure({
        type: 'Utility',
        reason: 'killed',
        exitCode: 15,
        name: 'Network Service',
      })?.isNetworkService,
    ).toBe(true);
  });

  it('keeps routine clean exits quiet', () => {
    expect(
      readDesktopChildFailure({ type: 'Utility', reason: 'clean-exit', exitCode: 0 }),
    ).toBeNull();
  });
});
