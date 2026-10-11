import { bundle } from '@remotion/bundler';
import { getCompositions, openBrowser, renderMedia, renderStill } from '@remotion/renderer';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { onboardingVideoExports } from '../examples/previews/onboarding/VideoExports.js';
import { videoNarration } from '../examples/previews/onboarding/VideoNarration.js';

const execute = promisify(execFile);
const { values } = parseArgs({ options: { 'browser-executable': { type: 'string' } } });
const output = resolve('src/desktop/assets/onboarding/vi');
await mkdir(resolve('.tro-development'), { recursive: true });
const temporary = await mkdtemp(resolve('.tro-development/onboarding-export-'));

/** Manual authoring command: reuse approved audio, encode locally, then install checked media only. */
try {
  const serveUrl = await bundle({
    entryPoint: resolve('examples/previews/onboarding/RegisterOnboardingVideos.tsx'),
    publicDir: resolve('examples/previews/onboarding/public'),
    outDir: resolve(temporary, 'bundle'),
    webpackOverride: (configuration) => ({
      ...configuration,
      resolve: {
        ...configuration.resolve,
        extensionAlias: { ...configuration.resolve?.extensionAlias, '.js': ['.js', '.ts', '.tsx'] },
      },
    }),
  });
  const executable = values['browser-executable'];
  const browser = await openBrowser('chrome', executable ? { browserExecutable: executable } : {});
  let totalBytes = 0;
  try {
    const compositions = await getCompositions(serveUrl, { puppeteerInstance: browser });
    for (const video of onboardingVideoExports) {
      const composition = compositions.find((entry) => entry.id === video.compositionId);
      if (
        !composition ||
        composition.durationInFrames !== 300 ||
        composition.fps !== 30 ||
        composition.width !== 1280 ||
        composition.height !== 720
      ) {
        throw new Error(`${video.compositionId}: expected a ten-second 720p composition.`);
      }
      const target = resolve(temporary, video.stem);
      console.info(`Exporting ${video.compositionId}…`);
      await renderMedia({
        serveUrl,
        composition,
        puppeteerInstance: browser,
        outputLocation: `${target}Source.mp4`,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        crf: 26,
        audioCodec: 'aac',
        audioBitrate: '64k',
        sampleRate: 48000,
        concurrency: 2,
        imageFormat: 'png',
      });
      const sourceProbe = await execute('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        `${target}Source.mp4`,
      ]);
      console.info('onboarding.export.encoded', {
        compositionId: video.compositionId,
        durationSeconds: z.coerce.number().positive().parse(sourceProbe.stdout.trim()),
        frames: composition.durationInFrames,
        fps: composition.fps,
      });
      /* AAC packet padding can extend the container past the frame timeline.
         Bound the final edit duration while preserving all 300 video frames. */
      await execute('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-i',
        `${target}Source.mp4`,
        '-t',
        '10',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-af',
        'atrim=duration=10,asetpts=PTS-STARTPTS',
        '-movflags',
        '+faststart',
        `${target}.mp4`,
      ]);
      await renderStill({
        serveUrl,
        composition,
        puppeteerInstance: browser,
        frame: 40,
        output: `${target}.png`,
        imageFormat: 'png',
        scale: 0.5,
      });
      await writeFile(`${target}.txt`, `${videoNarration[video.topic].text}\n`, 'utf8');
      const probe = await execute('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_name,width,height,pix_fmt,nb_frames',
        '-of',
        'json',
        `${target}.mp4`,
      ]);
      const rawMetadata: unknown = JSON.parse(probe.stdout);
      const metadata = z
        .object({
          format: z.object({ duration: z.coerce.number().positive().max(10) }),
          streams: z.array(
            z.object({
              codec_name: z.string(),
              width: z.number().optional(),
              height: z.number().optional(),
              pix_fmt: z.string().optional(),
              nb_frames: z.coerce.number().optional(),
            }),
          ),
        })
        .parse(rawMetadata);
      if (
        !metadata.streams.some(
          (stream) =>
            stream.codec_name === 'h264' &&
            stream.width === 1280 &&
            stream.height === 720 &&
            stream.pix_fmt === 'yuv420p' &&
            stream.nb_frames === 300,
        ) ||
        !metadata.streams.some((stream) => stream.codec_name === 'aac')
      ) {
        throw new Error(`${video.stem}: exported codecs or dimensions did not match.`);
      }
      /* Decode the whole export before replacing an installed clip. */
      await execute('ffmpeg', ['-v', 'error', '-i', `${target}.mp4`, '-f', 'null', '-']);
      totalBytes += (await stat(`${target}.mp4`)).size;
    }
  } finally {
    await browser.close({ silent: true });
  }
  await mkdir(output, { recursive: true });
  for (const video of onboardingVideoExports) {
    for (const extension of ['mp4', 'png', 'txt']) {
      await copyFile(
        resolve(temporary, `${video.stem}.${extension}`),
        resolve(output, `${video.stem}.${extension}`),
      );
    }
  }
  console.info(
    `Installed five ten-second videos: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB. No provider calls.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
