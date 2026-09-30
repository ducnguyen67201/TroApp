import { describe, expect, it } from 'vitest';
import {
  createDesktopEnvironment,
  createDevelopmentCommands,
  readDopplerTarget,
  runDevelopmentBootstrap,
} from './DevelopmentBootstrap.js';
import { type CommandRequest, type ExecuteCommand } from './RunCommand.js';

const SafeEnvironment = {
  APP_ENV: 'dev',
  DATABASE_URL: 'postgresql://tro:local_demo_only@127.0.0.1:54329/tro',
  PATH: '/tools',
} satisfies NodeJS.ProcessEnv;

function formatCommand(request: CommandRequest): string {
  return [request.command, ...request.arguments].join(' ');
}

function createSuccessfulExecutor(calls: string[]): ExecuteCommand {
  return (request) => {
    calls.push(formatCommand(request));

    return Promise.resolve({ stdout: request.command === 'pnpm' ? '11.16.0\n' : '' });
  };
}

describe('local development bootstrap', () => {
  it('validates prerequisites, starts PostgreSQL, migrates, generates, then launches', async () => {
    const calls: string[] = [];
    const processStarts: string[] = [];

    await runDevelopmentBootstrap({
      environment: SafeEnvironment,
      nodeVersion: 'v24.10.0',
      execute: createSuccessfulExecutor(calls),
      startProcesses: (target) => {
        processStarts.push(`${target.project}/${target.config}`);

        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      'pnpm --version',
      'docker --version',
      'docker compose version',
      'docker info',
      'doppler --version',
      'doppler me',
      'doppler run --project tro --config dev_local -- pnpm exec tsx scripts/ValidateLocalDevelopmentDatabase.ts',
      'docker compose up --detach --wait postgres',
      'doppler run --project tro --config dev_local -- pnpm db:migrate',
      'pnpm db:generate',
    ]);
    expect(processStarts).toEqual(['tro/dev_local']);
  });

  it('uses repeatable Compose startup and migration commands on every run', async () => {
    const calls: string[] = [];
    const execute = createSuccessfulExecutor(calls);
    let processStartCount = 0;
    const startProcesses = (): Promise<void> => {
      processStartCount += 1;

      return Promise.resolve();
    };

    for (let run = 0; run < 2; run += 1) {
      await runDevelopmentBootstrap({
        environment: SafeEnvironment,
        nodeVersion: '24.3.0',
        execute,
        startProcesses,
      });
    }

    expect(
      calls.filter((call) => call === 'docker compose up --detach --wait postgres'),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.endsWith('-- pnpm db:migrate'))).toHaveLength(2);
    expect(calls.some((call) => /(?:down|volume|rm)/.test(call))).toBe(false);
    expect(processStartCount).toBe(2);
  });

  it('stops immediately and reports the failing preparation step', async () => {
    const calls: string[] = [];
    const execute: ExecuteCommand = (request) => {
      const command = formatCommand(request);

      calls.push(command);
      if (command === 'docker compose up --detach --wait postgres') {
        return Promise.reject(new Error('compose failed'));
      }

      return Promise.resolve({ stdout: request.command === 'pnpm' ? '11.16.0' : '' });
    };
    let didStartProcesses = false;
    const startProcesses = (): Promise<void> => {
      didStartProcesses = true;

      return Promise.resolve();
    };

    await expect(
      runDevelopmentBootstrap({
        environment: SafeEnvironment,
        nodeVersion: 'v24.0.0',
        execute,
        startProcesses,
      }),
    ).rejects.toThrow('Local PostgreSQL did not become healthy');
    expect(calls.some((call) => call.endsWith('-- pnpm db:migrate'))).toBe(false);
    expect(didStartProcesses).toBe(false);
  });

  it('propagates a development process failure', async () => {
    const failure = new Error('desktop exited');

    await expect(
      runDevelopmentBootstrap({
        environment: SafeEnvironment,
        nodeVersion: 'v24.0.0',
        execute: createSuccessfulExecutor([]),
        startProcesses: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });

  it('allows only OS runtime values and explicit public desktop settings', () => {
    const desktopEnvironment = createDesktopEnvironment({
      PATH: '/tools',
      LANG: 'en_CA.UTF-8',
      DATABASE_URL: SafeEnvironment.DATABASE_URL,
      PROVIDER_API_KEY: 'not-for-desktop',
      DOPPLER_TOKEN: 'not-for-desktop',
      MAIN_VITE_API_BASE_URL: 'http://127.0.0.1:3000',
      MAIN_VITE_APP_ENV: 'dev',
      MAIN_VITE_UNREVIEWED: 'not-allowlisted',
      VITE_ACCIDENTAL_SECRET: 'not-allowlisted',
    });

    expect(desktopEnvironment).toEqual({
      PATH: '/tools',
      LANG: 'en_CA.UTF-8',
      MAIN_VITE_API_BASE_URL: 'http://127.0.0.1:3000',
      MAIN_VITE_APP_ENV: 'dev',
    });
  });

  it('keeps Doppler config selection in the development namespace', () => {
    expect(readDopplerTarget({})).toEqual({ project: 'tro', config: 'dev_local' });
    expect(() => readDopplerTarget({ TRO_DOPPLER_CONFIG: 'prd' })).toThrow(
      'dedicated development config',
    );
    expect(() => readDopplerTarget({ TRO_DOPPLER_PROJECT: 'tro; echo unsafe' })).toThrow(
      'only letters',
    );
  });

  it('isolates the backend and desktop child environments', () => {
    const environment = {
      ...SafeEnvironment,
      DOPPLER_TOKEN: 'doppler-auth',
      PROVIDER_API_KEY: 'parent-secret',
      MAIN_VITE_APP_ENV: 'dev',
    };
    const commands = createDevelopmentCommands(readDopplerTarget(environment), environment);
    const apiCommand = commands[0];
    const desktopCommand = commands[1];

    if (typeof apiCommand === 'string' || typeof desktopCommand === 'string') {
      throw new Error('Development commands must have isolated environments.');
    }

    const apiEnvironment = apiCommand?.env;
    const desktopEnvironment = desktopCommand?.env;

    expect(apiEnvironment).toMatchObject({ PATH: '/tools', DOPPLER_TOKEN: 'doppler-auth' });
    expect(apiEnvironment).not.toHaveProperty('DATABASE_URL');
    expect(apiEnvironment).not.toHaveProperty('PROVIDER_API_KEY');
    expect(desktopEnvironment).toMatchObject({ PATH: '/tools', MAIN_VITE_APP_ENV: 'dev' });
    expect(desktopEnvironment).not.toHaveProperty('DOPPLER_TOKEN');
    expect(desktopEnvironment).not.toHaveProperty('DATABASE_URL');
  });
});
