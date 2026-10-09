import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const commands = [];
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
  ipcMain.on('tro:pet-overlay-command', (_event, command) => { commands.push(command.kind); });
  await window.loadFile(process.argv[3]);
  for (const petId of petIds) {
    snapshot.preferences.activePetId = petId;
    snapshot.revision += 1;
    window.webContents.send('tro:pet-snapshot', snapshot);
    let painted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await window.webContents.executeJavaScript(
        "(async () => { const petId = " + JSON.stringify(petId) + "; const pet = document.querySelector('[data-pet-id=' + petId + ']'); if (!pet || window.tro !== undefined || Object.keys(window.troPet).sort().join(',') !== 'interactWithPet,readPet,subscribePet') return false; const layers = Array.from(pet.querySelectorAll('span')).filter(layer => layer.style.backgroundImage); if (layers.length !== 2) return false; return (await Promise.all(layers.map(layer => new Promise(resolve => { const source = layer.style.backgroundImage.slice(5, -2); const image = new Image(); image.onload = () => resolve(image.naturalWidth > 0 && image.naturalWidth === image.naturalHeight && source.startsWith('file:')); image.onerror = () => resolve(false); image.src = source; })))).every(Boolean); })()"
      );
      if (result === true) { painted = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!painted) { throw new Error('Pet image/preload failed: ' + petId); }
    let capture = await window.webContents.capturePage();
    let hasPetPixels = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bitmap = capture.crop({ x: 24, y: 52, width: 96, height: 96 }).toBitmap();
      hasPetPixels = bitmap.some((value, index) => index % 4 === 3 && value > 0);
      if (hasPetPixels) { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
      capture = await window.webContents.capturePage();
    }
    if (!hasPetPixels) { throw new Error('Pet did not paint: ' + petId); }
    await writeFile(join(process.argv[4], petId + '.png'), capture.toPNG());
  }

  // Real Chromium input checks capture/release ordering with the published component.
  snapshot.preferences.activePetId = 'fox';
  snapshot.revision += 1;
  window.webContents.send('tro:pet-snapshot', snapshot);
  const pause = () => new Promise(resolve => setTimeout(resolve, 80));
  await pause();
  await window.webContents.executeJavaScript(
    "window.petProbeEvents = []; for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'lostpointercapture']) document.addEventListener(type, event => window.petProbeEvents.push({type, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY, buttons: event.buttons}), true);"
  );
  const reacting = () => window.webContents.executeJavaScript(
    "(() => { const layers = Array.from(document.querySelectorAll('.pet-mascot span')).filter(layer => layer.style.backgroundImage); return layers.length === 2 && layers[1].style.opacity === '1'; })()"
  );
  const input = async (type, x, y, held = false) => {
    window.webContents.sendInputEvent({ type, x, y, globalX: x, globalY: y, button: 'left', clickCount: 1, modifiers: held ? ['leftButtonDown'] : [] });
    await pause();
  };
  await input('mouseMove', 72, 100);
  await input('mouseDown', 72, 100);
  await input('mouseMove', 90, 100, true);
  await input('mouseUp', 90, 100);
  if (await reacting() || !commands.includes('start-drag') || !commands.includes('end-drag')) {
    const events = await window.webContents.executeJavaScript('window.petProbeEvents');
    throw new Error('Drag/release failed or triggered a mascot reaction: ' + JSON.stringify({commands, events}));
  }
  await input('mouseMove', 72, 100);
  await input('mouseDown', 72, 100);
  await input('mouseUp', 72, 100);
  if (!await reacting()) { throw new Error('Ordinary mascot click did not react after dragging'); }
  snapshot.preferences.motion = 'reduced';
  snapshot.revision += 1;
  window.webContents.send('tro:pet-snapshot', snapshot);
  await pause();
  const still = await window.webContents.executeJavaScript(
    "Boolean(document.querySelector('.pet-mascot-still[role=img]') && !document.querySelector('button'))"
  );
  if (!still) { throw new Error('Reduced-motion fallback failed'); }
  clearTimeout(timeout);
  console.log('PASS: bundled sprites load and paint under CSP; drag suppresses clicks, ordinary clicks react, reduced motion is still, and preload stays restricted.');
  app.exit(0);
}).catch((error) => {
  console.error(error.message);
  clearTimeout(timeout);
  app.exit(1);
});
`;

try {
  await readFile(resolve('out/renderer/PageMascotLicense.txt'), 'utf8');
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
