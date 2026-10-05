import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import electron from 'electron';
import {
  createPetPreferences,
  PetId,
  PetReaction,
  type PetSnapshot,
} from '../src/contracts/Pet.js';
import { DesktopLocale } from '../src/contracts/DesktopLocale.js';

const executeFile = promisify(execFile);
const electronExecutable: unknown = electron;
if (typeof electronExecutable !== 'string') {
  throw new Error('Run this check with Node, not Electron.');
}
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tro-pet-presentation-'));
const previewDirectory = resolve('.tro-development/pets');
const snapshot: PetSnapshot = {
  revision: 1,
  preferences: { ...createPetPreferences(), enabled: true, locale: DesktopLocale.ENGLISH },
  reaction: PetReaction.IDLE,
  isVisible: true,
  hasPresentationError: false,
  encouragement: true,
};

/* An isolated offscreen Electron fixture loads the actual built preload/renderer.
 * It neither opens the Tro app nor reads its profile, auth, driver or provider keys. */
const probeSource = `
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
app.setPath('userData', join(__dirname, 'profile'));
const snapshot = ${JSON.stringify(snapshot)};
const petIds = ${JSON.stringify(Object.values(PetId))};
let window;
const timeout = setTimeout(() => { app.exit(1); }, 15000);
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 144, height: 160, show: false, transparent: true, focusable: false,
    webPreferences: { preload: process.argv[2], sandbox: true,
      contextIsolation: true, nodeIntegration: false, offscreen: true,
      additionalArguments: ['--tro-pet-overlay'] },
  });
  ipcMain.handle('tro:pet-overlay-read', (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unexpected sender');
    }
    return snapshot;
  });
  await window.loadFile(process.argv[3]);
  for (const petId of petIds) {
    snapshot.preferences.activePetId = petId;
    snapshot.revision += 1;
    window.webContents.send('tro:pet-snapshot', snapshot);
    let painted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await window.webContents.executeJavaScript(
        "(() => { const image = document.querySelector('img'); return Boolean(image && image.complete && image.naturalWidth === 32 && image.dataset.petId === " + JSON.stringify(petId) + " && image.src.startsWith('file:') && window.tro === undefined && Object.keys(window.troPet).sort().join(',') === 'interactWithPet,readPet,subscribePet'); })()"
      );
      if (result === true) { painted = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!painted) { throw new Error('Pet image/preload failed: ' + petId); }
    let capture = await window.webContents.capturePage();
    let hasPetPixels = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bitmap = capture.crop({ x: 24, y: 52, width: 96, height: 96 }).getBitmap();
      hasPetPixels = bitmap.some((value, index) => index % 4 === 3 && value > 0);
      if (hasPetPixels) { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
      capture = await window.webContents.capturePage();
    }
    if (!hasPetPixels) { throw new Error('Pet did not paint: ' + petId); }
    await writeFile(join(process.argv[4], petId + '.png'), capture.toPNG());
  }
  clearTimeout(timeout);
  console.log('PASS: all three built pet images load under CSP; sandbox exposes only pet capabilities.');
  app.exit(0);
}).catch((error) => {
  console.error(error.message);
  clearTimeout(timeout);
  app.exit(1);
});
`;

try {
  await mkdir(previewDirectory, { recursive: true });
  const probeFile = join(temporaryRoot, 'PetPresentationProbe.cjs');
  await writeFile(probeFile, probeSource);
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  const result = await executeFile(
    electronExecutable,
    [
      probeFile,
      resolve('out/preload/Preload.cjs'),
      resolve('out/renderer/Pet.html'),
      previewDirectory,
    ],
    { env: environment, timeout: 20_000 },
  );
  console.info(result.stdout.trim());
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
