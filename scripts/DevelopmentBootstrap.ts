import { concurrently, type ConcurrentlyCommandInput } from 'concurrently';
import {
  CommandOutput,
  type CommandRequest,
  type ExecuteCommand,
  executeCommand,
} from './RunCommand.js';

const SupportedNodeMajor = 24;
const SupportedPnpmMajor = 11;
const DefaultDopplerProject = 'tro';
const DefaultDopplerConfig = 'dev_local';
const DopplerNamePattern = /^[a-zA-Z0-9_-]+$/;
const DevelopmentConfigPattern = /^dev(?:[_-].+)?$/;

const SharedRuntimeEnvironmentNames = new Set([
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SSH_AUTH_SOCK',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
]);
const DopplerEnvironmentNames = new Set([
  'DOPPLER_API_HOST',
  'DOPPLER_CONFIG_DIR',
  'DOPPLER_ENABLE_DNS_RESOLVER',
  'DOPPLER_ENABLE_VERSION_CHECK',
  'DOPPLER_PASSPHRASE',
  'DOPPLER_TOKEN',
]);
const PublicDesktopEnvironmentNames = new Set(['MAIN_VITE_API_BASE_URL', 'MAIN_VITE_APP_ENV']);

export interface DopplerTarget {
  project: string;
  config: string;
}

export interface DevelopmentBootstrapOptions {
  environment: NodeJS.ProcessEnv;
  nodeVersion: string;
  execute?: ExecuteCommand;
  startProcesses?: (target: DopplerTarget, environment: NodeJS.ProcessEnv) => Promise<void>;
}

function readMajorVersion(version: string): number | undefined {
  const match = /^(?:v)?(\d+)\./.exec(version.trim());

  return match === null ? undefined : Number(match[1]);
}

function validateSupportedVersion(name: string, version: string, expectedMajor: number): void {
  if (readMajorVersion(version) !== expectedMajor) {
    throw new Error(
      `${name} ${String(expectedMajor)} is required; found ${version.trim() || 'an unknown version'}.`,
    );
  }
}

function copyAllowedEnvironment(
  source: NodeJS.ProcessEnv,
  allowedNames: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) => {
      const isLocale = name.startsWith('LC_');
      const isDesktopPublic = name.startsWith('MAIN_VITE_') && allowedNames.has(name);

      return (
        value !== undefined &&
        (SharedRuntimeEnvironmentNames.has(name) || isLocale || isDesktopPublic)
      );
    }),
  );
}

export function createDesktopEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return copyAllowedEnvironment(source, PublicDesktopEnvironmentNames);
}

export function createDopplerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = copyAllowedEnvironment(source, new Set());

  for (const name of DopplerEnvironmentNames) {
    const value = source[name];

    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

export function readDopplerTarget(environment: NodeJS.ProcessEnv): DopplerTarget {
  const project = environment['TRO_DOPPLER_PROJECT'] ?? DefaultDopplerProject;
  const config = environment['TRO_DOPPLER_CONFIG'] ?? DefaultDopplerConfig;

  if (!DopplerNamePattern.test(project) || !DopplerNamePattern.test(config)) {
    throw new Error('Doppler project and config names may contain only letters, numbers, _ and -.');
  }

  if (!DevelopmentConfigPattern.test(config)) {
    throw new Error(
      'TRO_DOPPLER_CONFIG must name a dedicated development config (dev, dev_*, or dev-*).',
    );
  }

  return { project, config };
}

function createDopplerRequest(
  target: DopplerTarget,
  environment: NodeJS.ProcessEnv,
  arguments_: string[],
  output: CommandOutput,
): CommandRequest {
  return {
    command: 'doppler',
    arguments: ['run', '--project', target.project, '--config', target.config, '--', ...arguments_],
    environment: createDopplerEnvironment(environment),
    output,
  };
}

async function runRequiredStep(
  failureMessage: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    throw new Error(failureMessage, { cause: error });
  }
}

export function createDevelopmentCommands(
  target: DopplerTarget,
  environment: NodeJS.ProcessEnv,
): ConcurrentlyCommandInput[] {
  return [
    {
      command: `doppler run --project ${target.project} --config ${target.config} -- pnpm dev:api`,
      name: 'api',
      env: createDopplerEnvironment(environment),
    },
    {
      command: 'pnpm dev:desktop',
      name: 'desktop',
      env: createDesktopEnvironment(environment),
    },
  ];
}

export async function startDevelopmentProcesses(
  target: DopplerTarget,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const { result } = concurrently(createDevelopmentCommands(target, environment), {
    killOthersOn: ['failure', 'success'],
    killSignal: 'SIGTERM',
    prefix: 'name',
  });

  await result;
}

/** Prepares local state in a fixed order, then supervises the API and desktop together. */
export async function runDevelopmentBootstrap(options: DevelopmentBootstrapOptions): Promise<void> {
  const run = options.execute ?? executeCommand;
  const startProcesses = options.startProcesses ?? startDevelopmentProcesses;
  const target = readDopplerTarget(options.environment);

  validateSupportedVersion('Node.js', options.nodeVersion, SupportedNodeMajor);

  const pnpmVersion = await run({
    command: 'pnpm',
    arguments: ['--version'],
    environment: createDopplerEnvironment(options.environment),
    output: CommandOutput.CAPTURE,
  });
  validateSupportedVersion('pnpm', pnpmVersion.stdout, SupportedPnpmMajor);

  await runRequiredStep(
    'Docker is required. Install Docker Desktop and make docker available.',
    () =>
      run({
        command: 'docker',
        arguments: ['--version'],
        environment: createDopplerEnvironment(options.environment),
        output: CommandOutput.IGNORE,
      }),
  );
  await runRequiredStep(
    'Docker Compose v2 is required. Install or enable the compose plugin.',
    () =>
      run({
        command: 'docker',
        arguments: ['compose', 'version'],
        environment: createDopplerEnvironment(options.environment),
        output: CommandOutput.IGNORE,
      }),
  );
  await runRequiredStep(
    'The Docker daemon is unavailable. Start Docker Desktop and try again.',
    () =>
      run({
        command: 'docker',
        arguments: ['info'],
        environment: createDopplerEnvironment(options.environment),
        output: CommandOutput.IGNORE,
      }),
  );
  await runRequiredStep(
    'The Doppler CLI is required. Install it from https://docs.doppler.com/docs/install-cli.',
    () =>
      run({
        command: 'doppler',
        arguments: ['--version'],
        environment: createDopplerEnvironment(options.environment),
        output: CommandOutput.IGNORE,
      }),
  );
  await runRequiredStep('Doppler authentication failed. Run `doppler login` and try again.', () =>
    run({
      command: 'doppler',
      arguments: ['me'],
      environment: createDopplerEnvironment(options.environment),
      output: CommandOutput.IGNORE,
    }),
  );
  await runRequiredStep(
    `Doppler config ${target.project}/${target.config} is unavailable or unsafe. Confirm access and its local DATABASE_URL and APP_ENV=dev values.`,
    () =>
      run(
        createDopplerRequest(
          target,
          options.environment,
          ['pnpm', 'exec', 'tsx', 'scripts/ValidateLocalDevelopmentDatabase.ts'],
          CommandOutput.INHERIT,
        ),
      ),
  );

  await runRequiredStep(
    'Local PostgreSQL did not become healthy. Inspect `docker compose logs postgres` and retry.',
    () =>
      run({
        command: 'docker',
        arguments: ['compose', 'up', '--detach', '--wait', 'postgres'],
        environment: createDopplerEnvironment(options.environment),
        output: CommandOutput.INHERIT,
      }),
  );
  await runRequiredStep('Local migration failed; the API and desktop were not started.', () =>
    run(
      createDopplerRequest(
        target,
        options.environment,
        ['pnpm', 'db:migrate'],
        CommandOutput.INHERIT,
      ),
    ),
  );
  await runRequiredStep(
    'Prisma client generation failed; the API and desktop were not started.',
    () =>
      run({
        command: 'pnpm',
        arguments: ['db:generate'],
        environment: createDopplerEnvironment(options.environment),
        output: CommandOutput.INHERIT,
      }),
  );

  await startProcesses(target, options.environment);
}
