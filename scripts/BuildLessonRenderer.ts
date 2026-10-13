import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { resolve } from 'node:path';

await bundle({
  entryPoint: resolve('src/lessonVideoPresentation/RegisterLessonVideo.tsx'),
  outDir: resolve('dist/lesson-bundle'),
  webpackOverride: (configuration) => ({
    ...configuration,
    resolve: { ...configuration.resolve, extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
  }),
});
console.info('Maintained lesson presentation bundled.');

const digest = createHash('sha256');
for (const directory of ['src/lessonVideoPresentation', 'src/lessonRenderer', 'src/contracts']) {
  for (const file of (await readdir(directory)).sort()) {
    if (/\.tsx?$/.test(file)) {
      digest.update(await readFile(`${directory}/${file}`));
    }
  }
}
digest.update(await readFile('package.json'));
await writeFile('dist/lesson-bundle/BuildId.txt', digest.digest('hex'));
