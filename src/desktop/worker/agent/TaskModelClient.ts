import { AsyncLocalStorage } from 'node:async_hooks';
import { OpenAIProvider, Runner } from '@openai/agents';
import OpenAI from 'openai';

const taskModels = new AsyncLocalStorage<TaskModelClient>();

/** A task-owned credential and request fence; no credential enters SDK global defaults. */
export class TaskModelClient {
  private token: string | null;
  private readonly abort = new AbortController();
  private readonly runner: Runner;

  constructor(token: string, baseURL: string, fetchModel: typeof fetch) {
    this.token = token;
    const client = new OpenAI({
      apiKey: 'task-scoped',
      baseURL,
      maxRetries: 0,
      fetch: (input, init) => {
        if (this.token === null) {
          throw new Error('The model task has ended.');
        }
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${this.token}`);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, this.abort.signal])
          : this.abort.signal;
        return fetchModel(input, { ...init, headers, signal });
      },
    });
    this.runner = new Runner({
      modelProvider: new OpenAIProvider({ openAIClient: client, useResponses: true }),
      tracingDisabled: true,
    });
  }

  refreshCredential(token: string): void {
    if (this.token === null) {
      throw new Error('The model task has ended.');
    }
    this.token = token;
  }

  readRunner(): Runner {
    if (this.token === null) {
      throw new Error('The model task has ended.');
    }
    return this.runner;
  }

  dispose(): void {
    this.token = null;
    this.abort.abort();
  }
}

/** Async context carries only the current task's disposable model adapter. */
export function runWithTaskModel<T>(model: TaskModelClient, run: () => Promise<T>): Promise<T> {
  return taskModels.run(model, run);
}

export function readTaskModelRunner(): Runner {
  const model = taskModels.getStore();
  if (!model) {
    throw new Error('No model task is bound.');
  }
  return model.readRunner();
}
