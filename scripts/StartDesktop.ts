import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { prepareDesktopDevelopmentHost } from './PrepareDesktopDevelopmentHost.js';

const executable = await prepareDesktopDevelopmentHost();

if (process.argv.includes('--prepare-only')) {
  console.info(`Prepared Tro development host: ${executable}`);
} else {
  const mode = process.argv.includes('--preview') ? 'preview' : 'dev';
  const child = spawn(
    process.execPath,
    [resolve('node_modules/electron-vite/bin/electron-vite.js'), mode],
    {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_EXEC_PATH: executable },
    },
  );
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', () => {
    console.error('Tro desktop launcher could not start.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
