import { readFile, writeFile } from 'node:fs/promises';
import {
  LessonRenderReplySchema,
  lessonRenderVersion,
  lessonVisualRuntimeVersion,
  LessonRendererHealthSchema,
} from '../src/contracts/LessonRenderProtocol.js';
import { spawn } from 'node:child_process';
import { LessonLayout } from '../src/contracts/LessonVideos.js';

// Offline fixture only: no model, speech provider, user material or database access.
const secret = (await readFile('.tro-development/LessonRendererSecret', 'utf8')).trim();
const rendererUrl = new URL(process.argv[2] ?? 'http://127.0.0.1:3010');
if (rendererUrl.protocol !== 'http:' || rendererUrl.hostname !== '127.0.0.1') {
  throw new Error('The offline renderer fixture requires a local HTTP worker.');
}
const healthResponse = await fetch(`${rendererUrl.origin}/health`, {
  headers: { authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(5000),
});
const health: unknown = await healthResponse.json();
if (LessonRendererHealthSchema.parse(health).visualRuntimeVersion !== lessonVisualRuntimeVersion) {
  throw new Error('Rebuild the renderer image to verify isolated visuals.');
}
const request = async (body: unknown): Promise<string> => {
  const response = await fetch(`${rendererUrl.origin}/render`, {
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
const visualFixtures = [
  {
    title: 'Counting: three choices for the units place',
    narration: 'The even digits are 2, 4 and 6. Move them together: there are three choices.',
    source: `
export default function Scene({frame}) {
  const progress = Math.min(1,frame/40);
  return <svg viewBox="0 0 1176 390">
    {[1,2,3,4,5,6].map((digit,index) => <g key={digit} transform={\`translate(\${100+index*150}, \${80+(digit%2===0?progress*120:0)})\`}>
      <circle r={32} fill={digit%2===0?'#e8ad50':'#e9efdf'}/>
      <text y={8} textAnchor="middle" fontSize={26} fill="#17372f">{digit}</text>
    </g>)}
    <text x={588} y={340} textAnchor="middle" fontSize={28} fill="#17372f">3 choices: 2, 4, 6</text>
  </svg>;
}`,
  },
  {
    title: 'Philosophy: compare two lines of reasoning',
    narration: 'The same dilemma can be evaluated by duties or by consequences.',
    source: `
export default function Scene({frame}) {
  return <svg viewBox="0 0 1176 390">
    <text x={588} y={45} textAnchor="middle" fontSize={28} fill="#17372f">Is lying ever justified?</text>
    <path d="M588 75 L290 170 M588 75 L880 170" stroke="#17372f" strokeWidth={3} fill="none"/>
    <g opacity={Math.min(1,frame/30)} fill="#17372f">
      <text x={290} y={220} textAnchor="middle" fontSize={24}>Consider the duty</text>
      <text x={880} y={220} textAnchor="middle" fontSize={24}>Consider the consequences</text>
    </g>
  </svg>;
}`,
  },
  {
    title: 'Scratch: see a repeat block execute',
    narration: 'Each iteration moves the sprite ten steps. The counter shows which iteration runs.',
    source: `
export default function Scene({frame}) {
  const iteration = Math.min(10,Math.floor(frame/5));
  return <svg viewBox="0 0 1176 390">
    <rect x={40} y={100} width={320} height={90} rx={12} fill="#e8ad50"/>
    <text x={60} y={150} fontSize={24} fill="#17372f">repeat 10: move 10 steps</text>
    <circle cx={500+iteration*35} cy={150} r={28} fill="#17372f"/>
    <text x={500} y={280} fontSize={24} fill="#17372f">Iteration: {iteration}</text>
  </svg>;
}`,
  },
];
for (const fixture of visualFixtures) {
  clips.push(
    await request({
      version: lessonRenderVersion,
      kind: 'clip',
      screen: {
        layout: LessonLayout.EXAMPLE,
        title: fixture.title,
        points: ['The maintained baseline remains available.'],
        narration: fixture.narration,
      },
      durationSeconds: 2,
      audio: null,
      visual: { source: fixture.source, runtimeVersion: lessonVisualRuntimeVersion },
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
  `Three maximum-content layouts, three isolated visuals, audio/text modes and final decoding passed (${String(video.length)} bytes, ${String(Date.now() - startedAt)} ms).`,
);
