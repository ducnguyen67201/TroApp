import { isAbsolute } from 'node:path';
import { createEnv } from '@t3-oss/env-core';
import { loadEnv } from 'vite';
import { AppUpdateUrlSchema } from '../src/contracts/AppUpdate.js';
import { z } from 'zod';
import { DesktopReleaseVersionSchema } from './ReleaseVersion.js';
import { NativeCompanionCacheSettingsSchema } from './NativeCompanionCache.js';

/** CI cache identity excludes credentials and pins the hosted compiler image. */
export function readNativeCompanionCacheEnv(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  architecture: string,
): {
  outputPath: string;
  settings: z.infer<typeof NativeCompanionCacheSettingsSchema>;
} {
  const validated = createEnv({
    server: {
      GITHUB_ACTIONS: z.literal('true'),
      GITHUB_REF: z.literal('refs/heads/main'),
      GITHUB_OUTPUT: z.string().min(1).refine(isAbsolute),
      ImageVersion: z.string().min(1),
      TRO_NATIVE_RUNNER_LABEL: z.string().min(1),
      RUSTUP_TOOLCHAIN: z.string().min(1),
      MACOSX_DEPLOYMENT_TARGET: z.string().optional(),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Native companion cache requires a main-branch hosted release environment.');
    },
  });
  return {
    outputPath: validated.GITHUB_OUTPUT,
    settings: NativeCompanionCacheSettingsSchema.parse({
      platform,
      architecture,
      runnerImage: validated.ImageVersion,
      runnerLabel: validated.TRO_NATIVE_RUNNER_LABEL,
      rustToolchain: validated.RUSTUP_TOOLCHAIN,
      deploymentTarget: validated.MACOSX_DEPLOYMENT_TARGET ?? '',
    }),
  };
}

/** Publishing is restricted to manually dispatched builds of the app repository's main branch. */
export function readReleasePublishingEnv(environment: NodeJS.ProcessEnv): {
  repository: string;
  commit: string;
  runId: string;
  attempt: string;
} {
  const validated = createEnv({
    server: {
      GITHUB_ACTIONS: z.literal('true'),
      GITHUB_EVENT_NAME: z.literal('workflow_dispatch'),
      GITHUB_REF: z.literal('refs/heads/main'),
      GITHUB_REPOSITORY: z.literal('ducnguyen67201/TroApp'),
      GITHUB_SHA: z.string().regex(/^[a-f0-9]{40}$/),
      GITHUB_RUN_ID: z.string().regex(/^[1-9][0-9]*$/),
      GITHUB_RUN_ATTEMPT: z.string().regex(/^[1-9][0-9]*$/),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Release publishing requires a main-branch TroApp workflow dispatch.');
    },
  });
  return {
    repository: validated.GITHUB_REPOSITORY,
    commit: validated.GITHUB_SHA,
    runId: validated.GITHUB_RUN_ID,
    attempt: validated.GITHUB_RUN_ATTEMPT,
  };
}

/** Only the main-branch GitHub release job may prepare a persisted version. */
export function readReleasePreparationEnv(environment: NodeJS.ProcessEnv): {
  sourceCommit: string;
  runId: string;
  outputPath: string;
} {
  const validated = createEnv({
    server: {
      GITHUB_ACTIONS: z.literal('true'),
      GITHUB_REF: z.literal('refs/heads/main'),
      GITHUB_SHA: z.string().regex(/^[a-f0-9]{40}$/),
      GITHUB_RUN_ID: z.string().regex(/^[1-9]\d{0,19}$/),
      GITHUB_OUTPUT: z.string().min(1).refine(isAbsolute),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Desktop release preparation configuration is invalid.');
    },
  });
  return {
    sourceCommit: validated.GITHUB_SHA,
    runId: validated.GITHUB_RUN_ID,
    outputPath: validated.GITHUB_OUTPUT,
  };
}

/** A reserved release version is applied by the explicit CI build step. */
export function readReleaseBuildEnv(environment: NodeJS.ProcessEnv): { version: string } {
  const validated = createEnv({
    server: {
      GITHUB_ACTIONS: z.literal('true'),
      TRO_DESKTOP_RELEASE_VERSION: DesktopReleaseVersionSchema,
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Desktop release build configuration is invalid.');
    },
  });
  return { version: validated.TRO_DESKTOP_RELEASE_VERSION };
}

/** Keep ps start times machine-readable without changing the launcher or service locales. */
export function readProcessListEnv(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, LC_ALL: 'C' };
}

/** Authoring-only speech generation receives its key from Doppler in this process. */
export function readOnboardingSpeechEnv(environment: NodeJS.ProcessEnv): { apiKey: string } {
  const validated = createEnv({
    server: { OPENAI_API_KEY: z.string().trim().min(1) },
    runtimeEnv: environment,
    emptyStringAsUndefined: true,
    onValidationError: () => {
      throw new Error('Onboarding narration requires OPENAI_API_KEY through Doppler.');
    },
  });
  return { apiKey: validated.OPENAI_API_KEY };
}

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
      MAIN_VITE_UPDATE_FEED_URL: AppUpdateUrlSchema,
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

/** Desktop development inherits OS paths, never backend credentials injected by Doppler. */
export function readDesktopChildEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const validated = createEnv({
    server: {
      PATH: z.string(),
      HOME: z.string(),
      TMPDIR: z.string().optional(),
      USER: z.string().optional(),
      SHELL: z.string().optional(),
      LANG: z.string().optional(),
      DISPLAY: z.string().optional(),
    },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Desktop host environment is invalid.');
    },
  });
  return {
    PATH: validated.PATH,
    HOME: validated.HOME,
    TMPDIR: validated.TMPDIR,
    USER: validated.USER,
    SHELL: validated.SHELL,
    LANG: validated.LANG,
    DISPLAY: validated.DISPLAY,
  };
}

export const MacNotarizationMethod = {
  API_KEY: 'api-key',
  KEYCHAIN_PROFILE: 'keychain-profile',
} as const;

export type MacSigningEnv =
  | { enabled: false }
  | ({
      enabled: true;
      architecture: 'arm64' | 'x64';
      identity: string;
      teamId: string;
      keychain: string;
    } & (
      | {
          notarizationMethod: typeof MacNotarizationMethod.API_KEY;
          apiKey: string;
          apiKeyId: string;
          apiIssuer: string;
        }
      | {
          notarizationMethod: typeof MacNotarizationMethod.KEYCHAIN_PROFILE;
          keychainProfile: string;
        }
    ));

/** Apple credentials belong to release tooling, never the packaged application. */
export function readMacSigningEnv(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  architecture: string,
): MacSigningEnv {
  const fail = (): never => {
    throw new Error('macOS release configuration is invalid.');
  };
  const mode = environment['TRO_SIGN_MACOS'];
  if (mode === undefined || mode === '' || mode === 'false') {
    return { enabled: false };
  }
  if (
    mode !== 'true' ||
    platform !== 'darwin' ||
    (architecture !== 'arm64' && architecture !== 'x64') ||
    environment['TRO_SIGN_WINDOWS'] === 'true' ||
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'CSC_LINK', 'CSC_NAME'].some((name) =>
      Boolean(environment[name]),
    )
  ) {
    return fail();
  }
  const absolutePath = z.string().min(1).refine(isAbsolute);
  const validated = createEnv({
    server: {
      MACOS_SIGNING_IDENTITY_SHA1: z.string().regex(/^[A-Fa-f0-9]{40}$/),
      APPLE_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/),
      CSC_KEYCHAIN: absolutePath,
      APPLE_API_KEY: absolutePath.optional(),
      APPLE_API_KEY_ID: z
        .string()
        .regex(/^[A-Z0-9]{10}$/)
        .optional(),
      APPLE_API_ISSUER: z.uuid().optional(),
      APPLE_KEYCHAIN: absolutePath.optional(),
      APPLE_KEYCHAIN_PROFILE: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
        .optional(),
      MAIN_VITE_API_BASE_URL: AppUpdateUrlSchema,
      MAIN_VITE_APP_ENV: z.literal('prod'),
      MAIN_VITE_UPDATE_FEED_URL: AppUpdateUrlSchema,
    },
    runtimeEnv: environment,
    emptyStringAsUndefined: true,
    onValidationError: fail,
  });
  if (
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(validated.MAIN_VITE_API_BASE_URL).hostname)
  ) {
    return fail();
  }
  const settings = {
    enabled: true,
    architecture,
    identity: validated.MACOS_SIGNING_IDENTITY_SHA1.toUpperCase(),
    teamId: validated.APPLE_TEAM_ID,
    keychain: validated.CSC_KEYCHAIN,
  } as const;
  const hasApiSettings =
    validated.APPLE_API_KEY !== undefined ||
    validated.APPLE_API_KEY_ID !== undefined ||
    validated.APPLE_API_ISSUER !== undefined;
  const hasProfileSettings =
    validated.APPLE_KEYCHAIN_PROFILE !== undefined || validated.APPLE_KEYCHAIN !== undefined;
  if (hasProfileSettings) {
    if (
      hasApiSettings ||
      validated.APPLE_KEYCHAIN_PROFILE === undefined ||
      validated.APPLE_KEYCHAIN !== settings.keychain
    ) {
      return fail();
    }
    return {
      ...settings,
      notarizationMethod: MacNotarizationMethod.KEYCHAIN_PROFILE,
      keychainProfile: validated.APPLE_KEYCHAIN_PROFILE,
    };
  }
  if (
    validated.APPLE_API_KEY === undefined ||
    validated.APPLE_API_KEY_ID === undefined ||
    validated.APPLE_API_ISSUER === undefined
  ) {
    return fail();
  }
  return {
    ...settings,
    notarizationMethod: MacNotarizationMethod.API_KEY,
    apiKey: validated.APPLE_API_KEY,
    apiKeyId: validated.APPLE_API_KEY_ID,
    apiIssuer: validated.APPLE_API_ISSUER,
  };
}
