import { bundle } from '@remotion/bundler';
import { ensureBrowser } from '@remotion/renderer';
import { writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { writeLessonPresentationIdentity } from './LessonPresentationIdentity.js';

/** Build trusted presentation once. Requests never supply source code or a bundle URL. */
const root = resolve('.');
const outDir = join(root, 'dist/lessonBundle');
await mkdir(outDir, { recursive: true });
const identity = await writeLessonPresentationIdentity(root);
await bundle({
  entryPoint: join(root, 'src/lessonMedia/RegisterLessonComposition.tsx'),
  outDir,
  enableCaching: false,
  webpackOverride: (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      alias: Array.isArray(config.resolve?.alias)
        ? [...config.resolve.alias, { name: '#contracts', alias: join(root, 'src/contracts') }]
        : { ...config.resolve?.alias, '#contracts': join(root, 'src/contracts') },
      extensionAlias: { ...config.resolve?.extensionAlias, '.js': ['.ts', '.tsx', '.js'] },
    },
  }),
});
await cp(
  join(root, 'node_modules/@fontsource/noto-sans/LICENSE'),
  join(outDir, 'NotoSansLicense.txt'),
);
await cp(
  join(root, 'node_modules/@fontsource/noto-sans-mono/LICENSE'),
  join(outDir, 'NotoSansMonoLicense.txt'),
);
const browserMode = 'chrome-for-testing';
const browser = await ensureBrowser({ logLevel: 'error', chromeMode: browserMode });
if (browser.type !== 'local-puppeteer-browser' && browser.type !== 'user-defined-path') {
  throw new Error('The pinned render browser is unavailable.');
}
/* macOS needs the entire application and its frameworks, not only Contents/MacOS. */
const browserDirectory =
  process.platform === 'darwin'
    ? resolve(dirname(browser.path), '../../..')
    : dirname(browser.path);
await rm(join(root, 'dist/lessonBrowser'), { recursive: true, force: true });
await cp(browserDirectory, join(root, 'dist/lessonBrowser'), { recursive: true, force: true });
await writeFile(
  join(outDir, 'PresentationIdentity.json'),
  JSON.stringify({
    ...identity,
    browserMode,
    browserPath: join('dist/lessonBrowser', relative(browserDirectory, browser.path)),
  }),
);
console.info('Trusted guided lesson presentation bundled.');
