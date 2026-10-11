import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { watchLessonRenderWorkerLifetime } from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderWorkerLifetime.js';

if (process.argv.includes('--browser')) {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      process.send?.({ browserPid: process.pid, port: address.port });
    }
  });
} else {
  watchLessonRenderWorkerLifetime(() => Promise.resolve());
  const browser = fork(new URL(import.meta.url), ['--browser'], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {},
    execArgv: ['--conditions=development', '--import', 'tsx'],
  });
  browser.once('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null) {
      process.send?.(message);
    }
  });
}
