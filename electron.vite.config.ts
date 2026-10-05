import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { reportBuildWarning } from './scripts/ReportBuildWarning';

export default defineConfig({
  main: {
    resolve: { alias: { '#contracts': resolve('src/contracts') } },
    build: {
      externalizeDeps: false,
      /* ws probes optional native accelerators inside try/catch. Keep those
         requires guarded instead of hoisting Vite's missing-peer error. */
      commonjsOptions: { ignore: ['bufferutil', 'utf-8-validate'] },
      rollupOptions: {
        onwarn: reportBuildWarning,
        external: ['uiohook-napi', '@trycua/cua-driver'],
      },
      lib: {
        entry: {
          Main: resolve('src/desktop/main/Main.ts'),
          StartAgentWorker: resolve('src/desktop/worker/StartAgentWorker.ts'),
          StartCompanionHudWorker: resolve('src/desktop/worker/StartCompanionHudWorker.ts'),
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
    },
  },
  preload: {
    resolve: { alias: { '#contracts': resolve('src/contracts') } },
    build: {
      externalizeDeps: false,
      rollupOptions: { onwarn: reportBuildWarning },
      lib: {
        entry: resolve('src/desktop/preload/Preload.ts'),
        formats: ['cjs'],
        fileName: () => 'Preload.cjs',
      },
    },
  },
  renderer: {
    root: resolve('src/desktop/renderer'),
    resolve: { alias: { '#contracts': resolve('src/contracts') } },
    plugins: [react()],
    server: { host: '127.0.0.1' },
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          main: resolve('src/desktop/renderer/index.html'),
          pet: resolve('src/desktop/renderer/Pet.html'),
        },
        onwarn: reportBuildWarning,
      },
    },
  },
});
