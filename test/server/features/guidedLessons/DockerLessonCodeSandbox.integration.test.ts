import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  DockerLessonCodeSandbox,
  NodeLessonDockerCommands,
  type LessonDockerCommands,
} from '../../../../src/server/features/guidedLessons/infrastructure/DockerLessonCodeSandbox.js';
import { readLessonGeometryIssues } from '../../../../src/server/features/guidedLessons/infrastructure/LessonGeometryDiagnostics.js';
import { validateLessonGeometry } from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderProtocol.js';
import { createLessonPlaybackFixture } from './LessonPlaybackFixture.js';

const SecurityProbeSchema = z.strictObject({
  uid: z.number().int(),
  capabilities: z.string(),
  networkInterfaces: z.array(z.string()),
  rootWritable: z.boolean(),
  inputWritable: z.boolean(),
  dockerSocketVisible: z.boolean(),
});

const Probe = String.raw`
const fs=require('node:fs');
function canWrite(path){try{fs.accessSync(path,fs.constants.W_OK);return true;}catch{return false;}}
process.stdout.write(JSON.stringify({
  uid:process.getuid(),
  capabilities:fs.readFileSync('/proc/self/status','utf8').split('\n').find(line=>line.startsWith('CapEff:')).split(':')[1].trim(),
  networkInterfaces:Object.keys(require('node:os').networkInterfaces()),
  rootWritable:canWrite('/app'),
  inputWritable:canWrite('/render/input/Scene.tsx'),
  dockerSocketVisible:fs.existsSync('/var/run/docker.sock'),
}));
`;

const Source = `
import React from 'react';
import {AbsoluteFill,useCurrentFrame} from 'remotion';
export default function Scene({projection}) {
  const frame=useCurrentFrame();
  return <AbsoluteFill style={{background:'#f6f3eb',padding:80,color:'#172f28',fontFamily:'Noto Sans',fontSize:56,gap:40}}>
    <div data-lesson-essential>{projection.sceneTitle}</div>
    <div data-lesson-essential style={{transform:'translateX('+frame+'px)'}}>Running total</div>
  </AbsoluteFill>;
}
`;

const ClippedSource = `
import React from 'react';
import {AbsoluteFill} from 'remotion';
export default function Scene() {
  return <AbsoluteFill style={{background:'#f6f3eb',color:'#172f28',fontFamily:'Noto Sans',fontSize:64}}>
    <div style={{position:'absolute',left:100,top:100,width:1500,height:140,overflow:'hidden'}}>
      <div style={{overflow:'visible'}}>
        <div data-lesson-essential style={{width:1200,height:230,lineHeight:'100px'}}>First visible line<br/>Second clipped line</div>
      </div>
    </div>
  </AbsoluteFill>;
}
`;

const EntranceSource = `
import React from 'react';
import {AbsoluteFill,useCurrentFrame} from 'remotion';
export default function Scene() {
  const shown=useCurrentFrame()>0;
  return <AbsoluteFill style={{background:'#f6f3eb',color:'#172f28',fontFamily:'Noto Sans',fontSize:64,lineHeight:'100px'}}>
    <div data-lesson-essential style={{position:'absolute',left:100,top:500,width:1500,height:100}}>Persistent visible heading</div>
    <div style={{position:'absolute',left:100,top:100,width:1500,height:100,overflow:'hidden'}}>
      <div style={{height:100,opacity:shown?1:0,transform:shown?'none':'translateY(120px)'}}><span data-lesson-essential>Visible after entrance</span></div>
    </div>
    <div style={{position:'absolute',left:100,top:300,width:1500,height:100,overflow:'hidden'}}>
      <div style={{opacity:shown?1:0.1}}><div style={{height:100,opacity:shown?1:0.05,transform:shown?'none':'translateY(120px)'}}><span data-lesson-essential>Nested opacity entrance</span></div></div>
    </div>
  </AbsoluteFill>;
}
`;

const ScaledSource = `
import React from 'react';
import {AbsoluteFill} from 'remotion';
export default function Scene() {
  return <AbsoluteFill style={{background:'#f6f3eb',color:'#172f28',fontFamily:'Noto Sans',fontSize:64,lineHeight:'100px'}}>
    <div style={{position:'absolute',left:100,top:100,transform:'scale3d(0.8,0.8,1)',transformOrigin:'top left'}}><div data-lesson-essential style={{width:1200,height:120,transform:'scale(0.875)',transformOrigin:'top left'}}>Nested transformed text</div></div>
    <div data-lesson-essential style={{position:'absolute',left:100,top:400,width:1200,height:120,zoom:0.7}}>Zoomed text</div>
    <div data-lesson-essential style={{position:'absolute',left:100,top:700,width:1200,height:120,scale:0.7,transformOrigin:'top left'}}>Individual scale text</div>
    <div data-lesson-essential style={{position:'absolute',left:100,top:900,width:1200,height:120,transform:'rotateX(60deg) scale(0.8)',transformOrigin:'top left'}}>Foreshortened text</div>
  </AbsoluteFill>;
}
`;

it('compiles agent TSX only inside the isolated image and produces real PNG evidence and silent H264 video', async () => {
  const driver = new NodeLessonDockerCommands();
  const image = 'tro-lesson-renderer:local';
  const inspected = await driver
    .run(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image], {
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    })
    .catch(() => ({ exitCode: 1, stdout: '' }));
  if (inspected.exitCode !== 0 || inspected.stdout.trim() !== 'linux/amd64') {
    throw new Error(
      'Build the generated lesson renderer before integration tests: docker build --platform linux/amd64 --target lesson-renderer -t tro-lesson-renderer:local .',
    );
  }
  const probes: z.infer<typeof SecurityProbeSchema>[] = [];
  const commands: LessonDockerCommands = {
    async run(arguments_, options) {
      if (arguments_[0] === 'exec' && arguments_.length === 5) {
        const name = arguments_[1];
        if (!name) {
          throw new Error('The container name is absent.');
        }
        const checked = await driver.run(['exec', name, 'node', '-e', Probe], {
          timeoutMs: 10_000,
          maxOutputBytes: 4096,
        });
        expect(checked.exitCode).toBe(0);
        const raw: unknown = JSON.parse(checked.stdout);
        probes.push(SecurityProbeSchema.parse(raw));
      }
      return driver.run(arguments_, options);
    },
  };
  const sandbox = new DockerLessonCodeSandbox({ image, commands });
  const request = {
    source: Source,
    projection: createLessonPlaybackFixture().projection,
    durationInFrames: 30,
  };
  const preview = await sandbox.preview(request, [0, 29], new AbortController().signal);
  expect(preview.frames).toHaveLength(2);
  for (const frame of preview.frames) {
    expect(frame.bytes.byteLength).toBeGreaterThan(1000);
    expect(frame.geometry).toHaveLength(2);
    expect(frame.geometry.every((box) => box.fontPx >= 48)).toBe(true);
  }
  const video = await sandbox.renderVideo(request, new AbortController().signal);
  expect(video.byteLength).toBeGreaterThan(1000);
  expect(Buffer.from(video.subarray(4, 8)).toString('ascii')).toBe('ftyp');
  expect(probes).toHaveLength(2);
  for (const probe of probes) {
    expect(probe).toEqual({
      uid: 1000,
      capabilities: '0000000000000000',
      networkInterfaces: ['lo'],
      rootWritable: false,
      inputWritable: false,
      dockerSocketVisible: false,
    });
  }
}, 180_000);

it('measures clipping by an overflow ancestor even when the leaf text fits its own box and viewport', async () => {
  const sandbox = new DockerLessonCodeSandbox('tro-lesson-renderer:local');
  const signal = new AbortController().signal;
  await sandbox.checkReady(signal);
  const preview = await sandbox.preview(
    {
      source: ClippedSource,
      projection: createLessonPlaybackFixture().projection,
      durationInFrames: 30,
    },
    [0],
    signal,
  );
  expect(preview.frames).toHaveLength(1);
  const frame = preview.frames[0];
  if (!frame) {
    throw new Error('The parent-clipping preview frame is absent.');
  }
  expect(frame.bytes.byteLength).toBeGreaterThan(1000);
  expect(frame.geometry).toHaveLength(2);
  expect(
    validateLessonGeometry(
      frame.geometry.map((box) => ({ ...box, clippedWidth: 0, clippedHeight: 0 })),
    ),
  ).toHaveLength(2);
  expect(frame.geometry.some((box) => (box.clippedHeight ?? 0) > 2)).toBe(true);
  expect(() => validateLessonGeometry(frame.geometry)).toThrow('clipped or below');
  expect(readLessonGeometryIssues(frame.geometry).join('\n')).toContain(
    'ancestor vertical clipping: clippedHeight=',
  );
}, 180_000);

it('ignores invisible ancestor-opacity entrances and measures the same text when it becomes visible', async () => {
  const sandbox = new DockerLessonCodeSandbox('tro-lesson-renderer:local');
  const signal = new AbortController().signal;
  await sandbox.checkReady(signal);
  const preview = await sandbox.preview(
    {
      source: EntranceSource,
      projection: createLessonPlaybackFixture().projection,
      durationInFrames: 30,
    },
    [0, 29],
    signal,
  );
  expect(preview.frames.map((frame) => frame.geometry.length)).toEqual([1, 3]);
  for (const frame of preview.frames) {
    expect(readLessonGeometryIssues(frame.geometry)).toEqual([]);
    expect(validateLessonGeometry(frame.geometry)).toEqual(frame.geometry);
  }
}, 180_000);

it('measures effective font size through nested transforms, CSS zoom, individual scale, and 3D foreshortening', async () => {
  const sandbox = new DockerLessonCodeSandbox('tro-lesson-renderer:local');
  const signal = new AbortController().signal;
  await sandbox.checkReady(signal);
  const preview = await sandbox.preview(
    {
      source: ScaledSource,
      projection: createLessonPlaybackFixture().projection,
      durationInFrames: 30,
    },
    [0],
    signal,
  );
  const frame = preview.frames[0];
  if (!frame) {
    throw new Error('The transformed-font preview frame is absent.');
  }
  expect(frame.geometry).toHaveLength(4);
  for (const box of frame.geometry.slice(0, 3)) {
    expect(box.fontPx).toBeCloseTo(44.8, 3);
  }
  expect(frame.geometry[3]?.fontPx).toBeCloseTo(25.6, 3);
  expect(
    validateLessonGeometry(frame.geometry.map((box) => ({ ...box, fontPx: 64 }))),
  ).toHaveLength(4);
  expect(() => validateLessonGeometry(frame.geometry)).toThrow('clipped or below');
  expect(readLessonGeometryIssues(frame.geometry).join('\n')).toContain('minimumFontPx=48');
}, 180_000);
