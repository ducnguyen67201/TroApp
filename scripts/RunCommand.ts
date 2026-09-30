import { spawn } from 'node:child_process';

export const CommandOutput = {
  CAPTURE: 'capture',
  IGNORE: 'ignore',
  INHERIT: 'inherit',
} as const;

export type CommandOutput = (typeof CommandOutput)[keyof typeof CommandOutput];

export interface CommandRequest {
  command: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  output: CommandOutput;
}

export interface CommandResult {
  stdout: string;
}

export type ExecuteCommand = (request: CommandRequest) => Promise<CommandResult>;

/** Runs one command without a shell so metadata and paths cannot become shell syntax. */
export async function executeCommand(request: CommandRequest): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const output = request.output === CommandOutput.CAPTURE ? 'pipe' : request.output;
    const child = spawn(request.command, request.arguments, {
      env: request.environment,
      stdio: request.output === CommandOutput.CAPTURE ? ['ignore', output, 'ignore'] : output,
    });
    const stdout: Buffer[] = [];

    if (request.output === CommandOutput.CAPTURE) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
      });
    }

    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString('utf8') });
        return;
      }

      const result = signal === null ? `exit code ${String(exitCode)}` : `signal ${signal}`;

      reject(new Error(`${request.command} ended with ${result}.`));
    });
  });
}
