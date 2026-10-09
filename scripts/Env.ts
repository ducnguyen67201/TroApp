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
