import { describe, expect, it } from 'vitest';
import { validateLessonSource } from '../../../../src/server/features/guidedLessons/infrastructure/ValidateLessonSource.js';

const PureScene = `import React, {useMemo, type CSSProperties} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
type Props = {projection: {sceneTitle: string; narrationCues: {text: string}[]}};
export default function Scene({projection}: Props) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const style: CSSProperties = useMemo(() => ({fontSize: 64, opacity: interpolate(frame, [0, fps], [0, 1])}), [frame, fps]);
  return <AbsoluteFill style={{background:'#f6f3eb'}}>
    <div data-lesson-essential style={style}>{projection.sceneTitle}</div>
    {projection.narrationCues.map((cue, index) => <p key={index} style={{fontSize:48}}>{cue.text}</p>)}
    <svg width={100} height={100}><defs><marker id="arrow"><path d="M0 0L10 5L0 10z"/></marker></defs><line x1={0} y1={0} x2={80} y2={80} markerEnd="url(#arrow)"/></svg>
  </AbsoluteFill>;
}`;

function sceneWith(body: string): string {
  return `export default function Scene({projection}) {${body}; return <div>{projection.sceneTitle}</div>;}`;
}

describe('generated lesson source quality contract', () => {
  it('allows pure frame-driven React, local bindings, typed props and inline SVG', () => {
    expect(() => {
      validateLessonSource(PureScene);
    }).not.toThrow();
    expect(() => {
      validateLessonSource('export default function Scene(){return <div>Running total</div>}');
    }).not.toThrow();
    expect(() => {
      validateLessonSource(
        `import * as R from 'react'; export default () => <R.Fragment><span>Question</span></R.Fragment>;`,
      );
    }).not.toThrow();
  });

  it.each([
    `import fs from 'node:fs'; export default () => <div/>;`,
    `import {Composition} from 'remotion'; export default () => <div/>;`,
    `import {registerRoot} from 'remotion'; export default () => <div/>;`,
    `import {Html5Video} from 'remotion'; export default () => <div/>;`,
    `import {useEffect} from 'react'; export default () => <div/>;`,
    `import 'react'; export default () => <div/>;`,
    `import * as R from 'remotion'; export default () => <div/>;`,
    `import React from 'react'; export default function Scene(){React['useEffect'](() => {}); return <div/>;}`,
  ])('rejects unsupported imports and stateful API access', (source) => {
    expect(() => {
      validateLessonSource(source);
    }).toThrow('Source quality contract:');
  });

  it.each([
    `console.info('tro.generated.geometry:[]')`,
    `const log = console; log.info('spoof')`,
    `document.querySelector('div')`,
    `window['console'].info('spoof')`,
    `globalThis['console'].info('spoof')`,
    `process.env.OPENAI_API_KEY`,
    `fetch('https://example.invalid')`,
    `setTimeout(() => {}, 0)`,
    `requestAnimationFrame(() => {})`,
    `Math.random()`,
    `new Date()`,
    `eval('1')`,
    `Function('return 1')()`,
    `require('fs')`,
    `import('react')`,
    `({}).constructor.constructor('return this')()`,
    `[]['con' + 'structor']('return this')()`,
    `this['console'].info('spoof')`,
    `alert('unknown global')`,
  ])('rejects direct and aliased global access, execution and measurement spoofing: %s', (body) => {
    expect(() => {
      validateLessonSource(sceneWith(body));
    }).toThrow('Source quality contract:');
  });

  it.each([
    '<script>bad</script>',
    '<style>body {display:none}</style>',
    '<iframe/>',
    '<audio/>',
    '<video/>',
    '<img src="remote"/>',
    '<div onClick={() => {}}/>',
    '<div dangerouslySetInnerHTML={{__html:"bad"}}/>',
    '<div ref={() => {}}/>',
    '<div {...projection}/>',
    '<div style={{backgroundImage:"url(https://example.invalid/image.png)"}}/>',
  ])('rejects events, injected HTML, media, remote assets and opaque JSX properties: %s', (jsx) => {
    expect(() => {
      validateLessonSource(`export default function Scene({projection}){return ${jsx};}`);
    }).toThrow('Source quality contract:');
  });

  it('requires a default export and rejects syntax errors before Docker starts', () => {
    expect(() => {
      validateLessonSource('const value = 1;');
    }).toThrow('default React component');
    expect(() => {
      validateLessonSource('export default function Scene(){return <div>');
    }).toThrow('syntax error');
  });

  it('reports bounded syntax codes and one-based positions without quoting malformed source', () => {
    const source = `export default function Scene() {
  const value = ;
  const second = ;
  const third = ;
  const fourth = ;
  return <PRIVATE_SOURCE_MARKER>{value}</div>;
}`;
    let failure: unknown;
    try {
      validateLessonSource(source);
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof Error)) {
      throw new Error('Expected a rejected malformed TSX module.');
    }
    expect(failure.message).toContain('TS1109 at line 2, column 17');
    expect(failure.message.match(/TS\d+ at line \d+, column \d+/g)).toHaveLength(3);
    expect(failure.message).toContain('additional diagnostics omitted');
    expect(failure.message).not.toContain('PRIVATE_SOURCE_MARKER');
    expect(failure.message).not.toContain('const value');
    expect(failure.message.length).toBeLessThan(500);
  });

  it('treats approved text and code strings as data, including names banned as APIs', () => {
    expect(() => {
      validateLessonSource(
        `export default () => <pre>{'console'} {'Math.random()'} {'document'}</pre>;`,
      );
    }).not.toThrow();
  });
});
