import { readFile, writeFile } from 'node:fs/promises';
import {
  LessonRenderReplySchema,
  lessonRenderVersion,
} from '../src/contracts/LessonRenderProtocol.js';
import { spawn } from 'node:child_process';
import { LessonLayout } from '../src/contracts/LessonVideos.js';

// Offline fixture only: no model, speech provider, user material or database access.
const secret = (await readFile('.tro-development/LessonRendererSecret', 'utf8')).trim();
const request = async (body: unknown): Promise<string> => {
  const response = await fetch('http://127.0.0.1:3010/render', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    throw new Error(`Renderer fixture failed (${String(response.status)}).`);
  }
  const data: unknown = await response.json();
  return LessonRenderReplySchema.parse(data).video;
};
const startedAt = Date.now();
const clips: string[] = [];
const pcm = Buffer.alloc(44 + 48000);
pcm.write('RIFF');
pcm.writeUInt32LE(pcm.length - 8, 4);
pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(24000, 24);
pcm.writeUInt32LE(48000, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write('data', 36);
pcm.writeUInt32LE(48000, 40);
for (let sample = 0; sample < 24000; sample += 1) {
  pcm.writeInt16LE(
    Math.round(Math.sin((sample * 2 * Math.PI * 440) / 24000) * 1000),
    44 + sample * 2,
  );
}

for (const layout of Object.values(LessonLayout)) {
  clips.push(
    await request({
      version: lessonRenderVersion,
      kind: 'clip',
      screen: {
        layout,
        title:
          'Boolean: giá trị đúng và sai — so sánh các ví dụ trong chương trình máy tính'.padEnd(
            80,
            'o',
          ),
        points: [
          'Một biểu thức Boolean có hai giá trị: True hoặc False. '.repeat(4).slice(0, 160),
          'Phép so sánh 5 < 10 có giá trị True vì 5 nhỏ hơn 10. '.repeat(4).slice(0, 160),
          'Phép so sánh 10 < 5 có giá trị False vì 10 lớn hơn 5. '.repeat(4).slice(0, 160),
        ],
        narration:
          'Boolean giúp chương trình lựa chọn hành động dựa trên một điều kiện đúng hay sai. '
            .repeat(14)
            .slice(0, 1000),
      },
      durationSeconds: 2,
      audio: layout === LessonLayout.EXPLANATION ? pcm.toString('base64') : null,
    }),
  );
}
const video = Buffer.from(
  await request({ version: lessonRenderVersion, kind: 'combine', clips }),
  'base64',
);
if (video.toString('ascii', 4, 8) !== 'ftyp') {
  throw new Error('Renderer did not return MP4.');
}
await writeFile('.tro-development/LessonFixture.mp4', video);
await new Promise<void>((resolve, reject) => {
  const child = spawn(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'lesson-renderer',
      'ffmpeg',
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-f',
      'null',
      '-',
    ],
    { stdio: ['pipe', 'inherit', 'inherit'], signal: AbortSignal.timeout(60000) },
  );
  child.once('error', reject);
  child.stdin.on('error', reject);
  child.once('exit', (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error('Rendered media could not be decoded.'));
    }
  });
  child.stdin.end(video);
});
console.info(
  `Three maximum-content templates, audio/text modes and final decoding passed (${String(video.length)} bytes, ${String(Date.now() - startedAt)} ms).`,
);
