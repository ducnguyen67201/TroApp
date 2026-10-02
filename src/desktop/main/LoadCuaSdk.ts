import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';

type NativeCuaSdk = Pick<
  typeof import('@trycua/cua-driver'),
  'EmbeddedCuaDriverHost' | 'currentMacOsPermissionStatus' | 'requestMacOsPermissions'
>;

export type DesktopDriverHost = Pick<
  import('@trycua/cua-driver').EmbeddedCuaDriverHost,
  'start' | 'stop' | 'waitForExit' | 'uniffiDestroy'
>;

export interface CuaSdk {
  readPermissions: NativeCuaSdk['currentMacOsPermissionStatus'];
  requestPermissions: NativeCuaSdk['requestMacOsPermissions'];
  createHost: (binaryPath: string, bundleId: string) => DesktopDriverHost;
}

function isCuaSdk(value: unknown): value is NativeCuaSdk {
  return (
    typeof value === 'object' &&
    value !== null &&
    'EmbeddedCuaDriverHost' in value &&
    typeof value.EmbeddedCuaDriverHost === 'function' &&
    'currentMacOsPermissionStatus' in value &&
    typeof value.currentMacOsPermissionStatus === 'function' &&
    'requestMacOsPermissions' in value &&
    typeof value.requestMacOsPermissions === 'function'
  );
}

/** Native SDK loading stays in main, after readiness. Packaged bindings and
 * their libraries share a physical resource tree outside Electron's ASAR. */
async function loadNativeCuaSdk(): Promise<NativeCuaSdk> {
  if (!app.isPackaged) {
    return import('@trycua/cua-driver');
  }
  const entry = pathToFileURL(
    join(
      process.resourcesPath,
      'cua-sdk',
      'node_modules',
      '@trycua',
      'cua-driver',
      'dist',
      'index.js',
    ),
  ).href;
  const sdk: unknown = await import(/* @vite-ignore */ entry);
  if (!isCuaSdk(sdk)) {
    throw new Error('The bundled desktop SDK is unavailable.');
  }
  return sdk;
}

export async function loadCuaSdk(): Promise<CuaSdk> {
  const sdk = await loadNativeCuaSdk();
  return {
    readPermissions: sdk.currentMacOsPermissionStatus,
    requestPermissions: sdk.requestMacOsPermissions,
    createHost: (binaryPath, bundleId) => new sdk.EmbeddedCuaDriverHost(binaryPath, bundleId),
  };
}
