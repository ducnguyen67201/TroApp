import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from 'electron';
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from '@trycua/cua-driver';
import { EmbeddedDesktopDriver } from '../../../src/desktop/main/EmbeddedDesktopDriver.js';
import {
  loadCuaSdk,
  type CuaSdk,
  type DesktopDriverHost,
} from '../../../src/desktop/main/LoadCuaSdk.js';
import { chooseCuaDriverCommand } from '../../../src/desktop/worker/cua/ChooseCuaDriverCommand.js';

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return true;
    },
  },
  shell: {},
}));
vi.mock('../../../src/desktop/main/LoadCuaSdk.js', () => ({ loadCuaSdk: vi.fn() }));
vi.mock('../../../src/desktop/worker/cua/ChooseCuaDriverCommand.js', () => ({
  chooseCuaDriverCommand: vi.fn(),
}));

const connection: EmbeddedDriverConnection = {
  socketPath: '/private/tro.sock',
  pid: 123,
  generation: 'test-generation',
  driverVersion: '0.30.4',
  contractVersion: 'test',
  mcpProtocolVersion: 'test',
  mcp: {
    command: '/tro/cua-driver',
    args: ['mcp', '--embedded', '--socket', '/private/tro.sock'],
    environment: [{ name: 'CUA_DRIVER_EMBEDDED', value: '1' }],
  },
};
const host: DesktopDriverHost & Pick<EmbeddedCuaDriverHost, 'waitForExit'> = {
  start: vi.fn<DesktopDriverHost['start']>(),
  stop: vi.fn<DesktopDriverHost['stop']>(),
  connection: vi.fn<DesktopDriverHost['connection']>(),
  waitForExit: vi.fn<EmbeddedCuaDriverHost['waitForExit']>(),
  uniffiDestroy: vi.fn<DesktopDriverHost['uniffiDestroy']>(),
};
const sdk: CuaSdk = {
  readPermissions: vi.fn<CuaSdk['readPermissions']>(),
  requestPermissions: vi.fn<CuaSdk['requestPermissions']>(),
  createHost: vi.fn<CuaSdk['createHost']>(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(loadCuaSdk).mockResolvedValue(sdk);
  vi.mocked(chooseCuaDriverCommand).mockResolvedValue({ command: '/tro/cua-driver' });
  vi.mocked(sdk.readPermissions).mockReturnValue({ accessibility: true, screenRecording: true });
  vi.mocked(sdk.createHost).mockReturnValue(host);
  vi.mocked(host.start).mockResolvedValue(connection);
  vi.mocked(host.stop).mockResolvedValue(undefined);
  vi.mocked(host.connection).mockReturnValue(connection);
  vi.mocked(host.waitForExit).mockImplementation(() => new Promise(() => {}));
  vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

it('connects the worker to the host-owned private endpoint and releases the daemon', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const driver = new EmbeddedDesktopDriver();
  expect(await driver.start(vi.fn<() => void>())).toEqual({
    command: connection.mcp.command,
    args: connection.mcp.args,
    env: { CUA_DRIVER_EMBEDDED: '1' },
  });
  expect(sdk.createHost).toHaveBeenCalledWith('/tro/cua-driver', 'app.tro.desktop');
  expect(sdk.requestPermissions).not.toHaveBeenCalled();
  await driver.stop();
  expect(host.stop).toHaveBeenCalledOnce();
  expect(host.uniffiDestroy).toHaveBeenCalledOnce();
});

it('never starts automation before the host grants both permissions', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  vi.mocked(sdk.readPermissions).mockReturnValue({ accessibility: false, screenRecording: true });
  await expect(new EmbeddedDesktopDriver().start(vi.fn<() => void>())).rejects.toThrow(
    'permissions',
  );
  expect(sdk.createHost).not.toHaveBeenCalled();
});

it('preserves the identity for a direct Electron launch', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(false);
  const driver = new EmbeddedDesktopDriver();
  await driver.start(vi.fn<() => void>());
  expect(sdk.createHost).toHaveBeenCalledWith('/tro/cua-driver', 'com.github.Electron');
  await driver.stop();
});

it('invalidates a worker connection when its daemon unexpectedly exits', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const onExit = vi.fn<() => void>();
  const driver = new EmbeddedDesktopDriver();
  await driver.start(onExit);
  vi.mocked(host.connection).mockReturnValue(undefined);
  vi.advanceTimersByTime(500);
  expect(onExit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000);
  expect(onExit).toHaveBeenCalledOnce();
  expect(host.connection).toHaveBeenCalledOnce();
  await driver.stop();
});

it('cancels pending startup and releases the host before admitting another worker', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  let resolveStart: ((value: EmbeddedDriverConnection) => void) | undefined;
  let notifyStart: (() => void) | undefined;
  const starting = new Promise<void>((resolve) => {
    notifyStart = resolve;
  });
  vi.mocked(host.start).mockImplementationOnce(() => {
    notifyStart?.();
    return new Promise((resolve) => {
      resolveStart = resolve;
    });
  });
  const driver = new EmbeddedDesktopDriver();
  const pending = driver.start(vi.fn<() => void>());
  const rejected = expect(pending).rejects.toThrow('canceled');
  await starting;
  const stopping = driver.stop();
  resolveStart?.(connection);
  await rejected;
  await stopping;
  expect(host.stop).toHaveBeenCalledOnce();
  expect(host.uniffiDestroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(host.connection).not.toHaveBeenCalled();
});

it('shares one daemon with both workers and invalidates every subscriber on unexpected exit', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const driver = new EmbeddedDesktopDriver();
  const hudExit = vi.fn<() => void>();
  const agentExit = vi.fn<() => void>();
  const [hudConnection, agentConnection] = await Promise.all([
    driver.start(hudExit),
    driver.start(agentExit),
  ]);
  expect(hudConnection).toEqual(agentConnection);
  await driver.start(agentExit);
  expect(host.start).toHaveBeenCalledOnce();
  expect(host.waitForExit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  vi.mocked(host.connection).mockReturnValue(undefined);
  vi.advanceTimersByTime(500);
  expect(hudExit).toHaveBeenCalledOnce();
  expect(agentExit).toHaveBeenCalledOnce();
  await driver.stop();
});

it('keeps one synchronous lifecycle watcher across sustained uptime', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const driver = new EmbeddedDesktopDriver();
  const onExit = vi.fn<() => void>();
  await driver.start(onExit);
  vi.advanceTimersByTime(60_000);
  expect(host.connection).toHaveBeenCalledTimes(120);
  expect(host.waitForExit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  expect(onExit).not.toHaveBeenCalled();
  await driver.stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000);
  expect(host.connection).toHaveBeenCalledTimes(120);
});

it('invalidates a connection if the native host switches generations', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const driver = new EmbeddedDesktopDriver();
  const onExit = vi.fn<() => void>();
  await driver.start(onExit);
  vi.mocked(host.connection).mockReturnValue({ ...connection, generation: 'replacement' });
  vi.advanceTimersByTime(500);
  expect(onExit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await driver.stop();
});

it('invalidates a connection if its native lifecycle can no longer be read', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const driver = new EmbeddedDesktopDriver();
  const onExit = vi.fn<() => void>();
  await driver.start(onExit);
  vi.mocked(host.connection).mockImplementation(() => {
    throw new Error('Native lifecycle unavailable.');
  });
  vi.advanceTimersByTime(500);
  expect(onExit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await driver.stop();
});

it('does not reuse an old watcher after stopping and restarting the native host', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const driver = new EmbeddedDesktopDriver();
  const oldExit = vi.fn<() => void>();
  await driver.start(oldExit);
  await driver.stop();
  const replacement = { ...connection, generation: 'replacement' };
  vi.mocked(host.start).mockResolvedValue(replacement);
  vi.mocked(host.connection).mockReturnValue(replacement);
  const replacementExit = vi.fn<() => void>();
  await driver.start(replacementExit);
  vi.advanceTimersByTime(500);
  expect(oldExit).not.toHaveBeenCalled();
  expect(replacementExit).not.toHaveBeenCalled();
  expect(host.connection).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  vi.mocked(host.connection).mockReturnValue(undefined);
  vi.advanceTimersByTime(500);
  expect(replacementExit).toHaveBeenCalledOnce();
  expect(oldExit).not.toHaveBeenCalled();
  await driver.stop();
});
