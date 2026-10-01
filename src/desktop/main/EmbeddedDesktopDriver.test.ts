import { beforeEach, expect, it, vi } from 'vitest';
import { app } from 'electron';
import type { EmbeddedDriverConnection } from '@trycua/cua-driver';
import { EmbeddedDesktopDriver } from './EmbeddedDesktopDriver.js';
import { loadCuaSdk, type CuaSdk, type DesktopDriverHost } from './LoadCuaSdk.js';
import { chooseCuaDriverCommand } from '../worker/ChooseCuaDriverCommand.js';

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return true;
    },
  },
  shell: {},
}));
vi.mock('./LoadCuaSdk.js', () => ({ loadCuaSdk: vi.fn() }));
vi.mock('../worker/ChooseCuaDriverCommand.js', () => ({ chooseCuaDriverCommand: vi.fn() }));

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
const host: DesktopDriverHost = {
  start: vi.fn<DesktopDriverHost['start']>(),
  stop: vi.fn<DesktopDriverHost['stop']>(),
  waitForExit: vi.fn<DesktopDriverHost['waitForExit']>(),
  uniffiDestroy: vi.fn<DesktopDriverHost['uniffiDestroy']>(),
};
const sdk: CuaSdk = {
  readPermissions: vi.fn<CuaSdk['readPermissions']>(),
  requestPermissions: vi.fn<CuaSdk['requestPermissions']>(),
  createHost: vi.fn<CuaSdk['createHost']>(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadCuaSdk).mockResolvedValue(sdk);
  vi.mocked(chooseCuaDriverCommand).mockResolvedValue({ command: '/tro/cua-driver' });
  vi.mocked(sdk.readPermissions).mockReturnValue({ accessibility: true, screenRecording: true });
  vi.mocked(sdk.createHost).mockReturnValue(host);
  vi.mocked(host.start).mockResolvedValue(connection);
  vi.mocked(host.stop).mockResolvedValue(undefined);
  vi.mocked(host.waitForExit).mockImplementation(() => new Promise(() => {}));
  vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(true);
});

it('connects the worker to the host-owned private endpoint and releases the daemon', async () => {
  if (process.platform !== 'darwin') return;
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
  if (process.platform !== 'darwin') return;
  vi.mocked(sdk.readPermissions).mockReturnValue({ accessibility: false, screenRecording: true });
  await expect(new EmbeddedDesktopDriver().start(vi.fn<() => void>())).rejects.toThrow(
    'permissions',
  );
  expect(sdk.createHost).not.toHaveBeenCalled();
});

it('uses the development Electron identity instead of claiming Tro', async () => {
  if (process.platform !== 'darwin') return;
  vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(false);
  const driver = new EmbeddedDesktopDriver();
  await driver.start(vi.fn<() => void>());
  expect(sdk.createHost).toHaveBeenCalledWith('/tro/cua-driver', 'com.github.Electron');
  await driver.stop();
});

it('invalidates a worker connection when its daemon unexpectedly exits', async () => {
  if (process.platform !== 'darwin') return;
  let resolveExit:
    ((exit: Awaited<ReturnType<DesktopDriverHost['waitForExit']>>) => void) | undefined;
  vi.mocked(host.waitForExit).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveExit = resolve;
      }),
  );
  const onExit = vi.fn<() => void>();
  const driver = new EmbeddedDesktopDriver();
  await driver.start(onExit);
  resolveExit?.({ generation: connection.generation, success: false, code: 1 });
  await Promise.resolve();
  expect(onExit).toHaveBeenCalledOnce();
  await driver.stop();
});

it('cancels pending startup and releases the host before admitting another worker', async () => {
  if (process.platform !== 'darwin') return;
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
});
