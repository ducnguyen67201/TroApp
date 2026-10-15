import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareElectronHeaders, type ElectronHeaderPorts } from '../../scripts/ElectronHeaders.js';

const settings = { electronVersion: '44.5.1', architecture: 'x64' };

function createPorts(): ElectronHeaderPorts {
  return {
    installHeaders: vi.fn<ElectronHeaderPorts['installHeaders']>().mockResolvedValue(undefined),
    wait: vi.fn<ElectronHeaderPorts['wait']>().mockResolvedValue(undefined),
    log: vi.fn<ElectronHeaderPorts['log']>(),
  };
}

describe('Electron header preparation', () => {
  it.each(['x64', 'arm64'])(
    'prepares %s headers in the sequential rebuild cache',
    async (architecture) => {
      const ports = createPorts();
      await prepareElectronHeaders({ ...settings, architecture }, ports);
      expect(ports.installHeaders).toHaveBeenCalledExactlyOnceWith([
        'install',
        '--ensure',
        '--target=44.5.1',
        `--arch=${architecture}`,
        '--dist-url=https://www.electronjs.org/headers',
        `--devdir=${join(homedir(), '.electron-gyp')}`,
      ]);
      expect(ports.wait).not.toHaveBeenCalled();
      expect(ports.log).toHaveBeenLastCalledWith({
        event: 'desktop.headers.prepare.completed',
        electronVersion: settings.electronVersion,
        architecture,
        attempt: 1,
      });
    },
  );

  it('recovers from the observed connection timeout without exposing command output', async () => {
    const ports = createPorts();
    vi.mocked(ports.installHeaders).mockRejectedValueOnce({
      stderr: 'gyp ERR! UND_ERR_CONNECT_TIMEOUT private=secret-value',
    });
    await prepareElectronHeaders(settings, ports);
    expect(ports.installHeaders).toHaveBeenCalledTimes(2);
    expect(ports.wait).toHaveBeenCalledExactlyOnceWith(1000);
    expect(ports.log).toHaveBeenCalledWith({
      event: 'desktop.headers.prepare.retry',
      ...settings,
      attempt: 1,
      failureCode: 'UND_ERR_CONNECT_TIMEOUT',
      delayMs: 1000,
    });
    expect(JSON.stringify(vi.mocked(ports.log).mock.calls)).not.toContain('secret-value');
  });

  it('stops after three network failures', async () => {
    const ports = createPorts();
    vi.mocked(ports.installHeaders).mockRejectedValue({ stderr: 'gyp ERR! ECONNRESET' });
    await expect(prepareElectronHeaders(settings, ports)).rejects.toThrow(
      'Electron header preparation failed',
    );
    expect(ports.installHeaders).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ports.wait).mock.calls).toEqual([[1000], [2000]]);
    expect(ports.log).toHaveBeenLastCalledWith({
      event: 'desktop.headers.prepare.failed',
      ...settings,
      attempt: 3,
      failureCode: 'ECONNRESET',
    });
  });

  it.each([
    { stderr: 'gyp ERR! checksum mismatch' },
    { stderr: 'gyp ERR! EACCES' },
    { stderr: 'gyp ERR! certificate has expired' },
    { stderr: 'gyp ERR! NOT_UND_ERR_CONNECT_TIMEOUT' },
    new Error('private configuration'),
    null,
  ])('does not retry other failures', async (error) => {
    const ports = createPorts();
    vi.mocked(ports.installHeaders).mockRejectedValue(error);
    await expect(prepareElectronHeaders(settings, ports)).rejects.toThrow(
      'Electron header preparation failed',
    );
    expect(ports.installHeaders).toHaveBeenCalledTimes(1);
    expect(ports.wait).not.toHaveBeenCalled();
  });

  it.each([
    { ...settings, electronVersion: '^44.5.1' },
    { ...settings, architecture: 'ia32' },
    { ...settings, electronVersion: '--unsafe' },
  ])('rejects unsupported targets before invoking node-gyp', async (input) => {
    const ports = createPorts();
    await expect(prepareElectronHeaders(input, ports)).rejects.toThrow();
    expect(ports.installHeaders).not.toHaveBeenCalled();
  });
});
