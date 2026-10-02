import { app } from 'electron';
import {
  DesktopDriverConnectionSchema,
  type DesktopDriverConnection,
} from '#contracts/DesktopDriver.js';
import { DesktopPermissionState } from '#contracts/DesktopPermissions.js';
import { chooseCuaDriverCommand } from '../worker/ChooseCuaDriverCommand.js';
import { DesktopPermissions } from './DesktopPermissions.js';
import { loadCuaSdk, type DesktopDriverHost } from './LoadCuaSdk.js';

/** Main directly owns the embedded macOS daemon and its private MCP endpoint.
 * No LaunchServices launch or connection to an independent driver's daemon. */
export class EmbeddedDesktopDriver {
  private host: DesktopDriverHost | null = null;
  private startPromise: Promise<DesktopDriverConnection> | null = null;
  private stopPromise: Promise<void> | null = null;
  private generation = 0;

  async start(onExit: () => void): Promise<DesktopDriverConnection> {
    await this.stopPromise;
    if (this.startPromise) {
      return this.startPromise;
    }
    const generation = this.generation;
    this.startPromise = this.startDriver(generation, onExit);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.generation += 1;
    const pendingStart = this.startPromise;
    const stopping = (async () => {
      try {
        await pendingStart;
      } catch {
        /* Startup failure still requires releasing the native host below. */
      }
      const host = this.host;
      this.host = null;
      if (host) {
        try {
          await host.stop();
        } finally {
          host.uniffiDestroy();
        }
      }
    })();
    this.stopPromise = stopping;
    void stopping
      .finally(() => {
        if (this.stopPromise === stopping) {
          this.stopPromise = null;
        }
      })
      .catch(() => {});
    return stopping;
  }

  private async startDriver(
    generation: number,
    onExit: () => void,
  ): Promise<DesktopDriverConnection> {
    const installation = await chooseCuaDriverCommand();
    if (process.platform !== 'darwin') {
      return { command: installation.command, args: ['mcp'], env: {} };
    }
    if ((await new DesktopPermissions().readStatus()).kind !== DesktopPermissionState.READY) {
      throw new Error('Tro desktop permissions are missing.');
    }
    const sdk = await loadCuaSdk();
    if (generation !== this.generation) {
      throw new Error('Desktop driver startup was canceled.');
    }
    /* Development Electron has its own bundle identity. A packaged Tro uses
       app.tro.desktop; claiming that identity in plain dev would fail closed. */
    const bundleId = app.isPackaged ? 'app.tro.desktop' : 'com.github.Electron';
    const host = this.host ?? sdk.createHost(installation.command, bundleId);
    this.host = host;
    const connection = await host.start();
    if (generation !== this.generation) {
      throw new Error('Desktop driver startup was canceled.');
    }
    void host
      .waitForExit(connection.generation)
      .then(() => {
        if (generation === this.generation && this.host === host) {
          onExit();
        }
      })
      .catch(() => {
        if (generation === this.generation && this.host === host) {
          onExit();
        }
      });
    return DesktopDriverConnectionSchema.parse({
      command: connection.mcp.command,
      args: connection.mcp.args,
      env: Object.fromEntries(connection.mcp.environment.map(({ name, value }) => [name, value])),
    });
  }
}
