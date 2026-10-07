import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface DevelopmentHostConfig {
  projectDirectory: string;
  appName: string;
}

function isDevelopmentHostConfig(value: unknown): value is DevelopmentHostConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectDirectory' in value &&
    typeof value.projectDirectory === 'string' &&
    isAbsolute(value.projectDirectory) &&
    'appName' in value &&
    typeof value.appName === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.appName) &&
    Object.keys(value).length === 2
  );
}

/* This TypeScript entry is compiled into the local development bundle. Finder
   and URL launches supply no project argument, unlike electron-vite launches. */
const directory = dirname(fileURLToPath(import.meta.url));
const config: unknown = JSON.parse(readFileSync(join(directory, 'HostConfig.json'), 'utf8'));
if (!isDevelopmentHostConfig(config)) {
  throw new Error('Tro development host configuration is invalid.');
}
app.setName(config.appName);
app.setPath('userData', join(app.getPath('appData'), config.appName));
process.chdir(config.projectDirectory);

/* A cold URL launch can arrive before the dynamically imported main module
   registers Better Auth. Queue only events the SDK has not already received. */
const earlyLinks: { event: Electron.Event; url: string }[] = [];

function receiveEarlyLink(event: Electron.Event, url: string): void {
  if (app.listenerCount('open-url') === 1) {
    event.preventDefault();
    earlyLinks.push({ event, url });
  }
}

app.on('open-url', receiveEarlyLink);
await import(pathToFileURL(join(config.projectDirectory, 'out', 'main', 'Main.js')).href);
app.removeListener('open-url', receiveEarlyLink);
for (const link of earlyLinks) {
  app.emit('open-url', link.event, link.url);
}
