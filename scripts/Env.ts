import { createEnv } from '@t3-oss/env-core';
import { loadEnv } from 'vite';
import { AppUpdateUrlSchema } from '../src/contracts/AppUpdate.js';
import { z } from 'zod';

/** Return configuration presence only. Proxy addresses, CA paths and keys stay private. */
export function readModelConnectionEnv(
  environment: NodeJS.ProcessEnv,
  nodeArguments: readonly string[] = [],
): {
  httpProxyConfigured: boolean;
  httpsProxyConfigured: boolean;
  allProxyConfigured: boolean;
  proxyExclusionsConfigured: boolean;
  environmentProxyRequested: boolean;
  customCaConfigured: boolean;
  tlsVerificationDisabled: boolean;
} {
  const optionalValue = z.string().optional();
  const validated = createEnv({
    server: {
      HTTP_PROXY: optionalValue,
      HTTPS_PROXY: optionalValue,
      http_proxy: optionalValue,
      https_proxy: optionalValue,
      ALL_PROXY: optionalValue,
      all_proxy: optionalValue,
      NO_PROXY: optionalValue,
      no_proxy: optionalValue,
      NODE_USE_ENV_PROXY: optionalValue,
      NODE_OPTIONS: optionalValue,
      NODE_EXTRA_CA_CERTS: optionalValue,
      SSL_CERT_FILE: optionalValue,
      SSL_CERT_DIR: optionalValue,
      NODE_TLS_REJECT_UNAUTHORIZED: optionalValue,
    },
    runtimeEnv: environment,
    emptyStringAsUndefined: true,
    onValidationError: () => {
      throw new Error('Model connection probe configuration is invalid.');
    },
  });
  return {
    httpProxyConfigured: Boolean(validated.http_proxy ?? validated.HTTP_PROXY),
    httpsProxyConfigured: Boolean(validated.https_proxy ?? validated.HTTPS_PROXY),
    allProxyConfigured: Boolean(validated.all_proxy ?? validated.ALL_PROXY),
    proxyExclusionsConfigured: Boolean(validated.no_proxy ?? validated.NO_PROXY),
    environmentProxyRequested:
      validated.NODE_USE_ENV_PROXY === '1' ||
      nodeArguments.includes('--use-env-proxy') ||
      /(?:^|\s)--use-env-proxy(?:\s|$)/.test(validated.NODE_OPTIONS ?? ''),
    customCaConfigured: Boolean(
      validated.NODE_EXTRA_CA_CERTS ?? validated.SSL_CERT_FILE ?? validated.SSL_CERT_DIR,
    ),
    tlsVerificationDisabled: validated.NODE_TLS_REJECT_UNAUTHORIZED === '0',
  };
}

/** Packaging reads only the public release address; credentials never enter it. */
export function readDesktopReleaseEnv(
  environment: NodeJS.ProcessEnv,
  fileEnvironment: Readonly<Record<string, string>> = {},
): {
  updateFeedUrl: string | undefined;
} {
  const validated = createEnv({
    server: { MAIN_VITE_UPDATE_FEED_URL: AppUpdateUrlSchema.optional() },
    runtimeEnv: {
      MAIN_VITE_UPDATE_FEED_URL:
        environment['MAIN_VITE_UPDATE_FEED_URL'] ?? fileEnvironment['MAIN_VITE_UPDATE_FEED_URL'],
    },
    emptyStringAsUndefined: true,
    onValidationError: () => {
      throw new Error('Desktop release configuration is invalid.');
    },
  });
  return { updateFeedUrl: validated.MAIN_VITE_UPDATE_FEED_URL };
}

/** Match electron-vite's production env files before validating public settings. */
export function loadDesktopReleaseEnv(): ReturnType<typeof readDesktopReleaseEnv> {
  return readDesktopReleaseEnv(process.env, loadEnv('production', process.cwd(), 'MAIN_VITE_'));
}

export type WindowsSigningEnv =
  | { enabled: false }
  | { enabled: true; endpoint: string; account: string; profile: string; publisher: string };

/** Signing is opt-in for release jobs; local packaging never needs Azure credentials. */
export function readWindowsSigningEnv(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  architecture: string,
): WindowsSigningEnv {
  const fail = (): never => {
    throw new Error('Windows release configuration is invalid.');
  };
  const mode = environment['TRO_SIGN_WINDOWS'];
  if (mode === undefined || mode === '' || mode === 'false') {
    return { enabled: false };
  }
  if (mode !== 'true' || platform !== 'win32' || architecture !== 'x64') {
    return fail();
  }
  const validated = createEnv({
    server: {
      AZURE_SIGNING_ENDPOINT: AppUpdateUrlSchema,
      AZURE_SIGNING_ACCOUNT: z.string().regex(/^[a-zA-Z0-9-]+$/),
      AZURE_CERTIFICATE_PROFILE: z.string().regex(/^[a-zA-Z0-9-]+$/),
      AZURE_SIGNING_PUBLISHER: z.string().trim().min(1).max(256),
      MAIN_VITE_API_BASE_URL: AppUpdateUrlSchema,
      MAIN_VITE_APP_ENV: z.literal('prod'),
      MAIN_VITE_UPDATE_FEED_URL: AppUpdateUrlSchema.optional(),
    },
    runtimeEnv: environment,
    emptyStringAsUndefined: true,
    onValidationError: fail,
  });
  const apiHostname = new URL(validated.MAIN_VITE_API_BASE_URL).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(apiHostname)) {
    return fail();
  }
  return {
    enabled: true,
    endpoint: validated.AZURE_SIGNING_ENDPOINT,
    account: validated.AZURE_SIGNING_ACCOUNT,
    profile: validated.AZURE_CERTIFICATE_PROFILE,
    publisher: validated.AZURE_SIGNING_PUBLISHER,
  };
}
