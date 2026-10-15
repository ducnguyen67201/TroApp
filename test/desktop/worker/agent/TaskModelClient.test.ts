import { Agent } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import {
  TaskModelClient,
  readTaskModelRunner,
  runWithTaskModel,
} from '../../../../src/desktop/worker/agent/TaskModelClient.js';

it('keeps credentials scoped, refreshes them, and fences retained runners after disposal', async () => {
  const tokens: (string | null)[] = [];
  const fetchModel = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
    tokens.push(new Headers(init?.headers).get('authorization'));
    return Promise.reject(new Error('fixture transport'));
  });
  const scope = new TaskModelClient('first-token', 'http://127.0.0.1:1', fetchModel);
  const agent = new Agent({ name: 'fixture', model: 'gpt-5.4' });
  const runner = scope.readRunner();
  await expect(
    runWithTaskModel(scope, () => readTaskModelRunner().run(agent, 'hello')),
  ).rejects.toThrow();
  scope.refreshCredential('second-token');
  await expect(runner.run(agent, 'hello')).rejects.toThrow();
  expect(tokens).toEqual(['Bearer first-token', 'Bearer second-token']);
  scope.dispose();
  expect(() => {
    scope.refreshCredential('late-token');
  }).toThrow('ended');
  expect(() => scope.readRunner()).toThrow('ended');
  await expect(runner.run(agent, 'hello')).rejects.toThrow();
  expect(fetchModel).toHaveBeenCalledTimes(2);
  expect(() => readTaskModelRunner()).toThrow('No model task');
});

it('does not use the preceding task model from an asynchronous continuation', async () => {
  const scope = new TaskModelClient('token', 'http://127.0.0.1:1', vi.fn<typeof fetch>());
  let resume = (): void => {};
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const delayed = runWithTaskModel(scope, async () => {
    await barrier;
    return readTaskModelRunner();
  });
  scope.dispose();
  resume();
  await expect(delayed).rejects.toThrow('ended');
});
