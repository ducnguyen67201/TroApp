import { AbsoluteFill, Html5Audio, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ReactElement } from 'react';
import type { LessonRenderProps } from '../contracts/LessonRenderProtocol.js';
import { LessonLayout } from '../contracts/LessonVideos.js';
import { splitNarration } from './NarrationTiming.js';
import { LessonVisual } from './LessonVisual.js';
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-700.css';
import '@fontsource/noto-sans/vietnamese-400.css';
import '@fontsource/noto-sans/vietnamese-700.css';

/** The maintained frame owns title, audio and captions; custom props are inert SVG data. */
export function LessonComposition({
  screen,
  audioUrl,
  visualFrames,
}: LessonRenderProps): ReactElement {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = frame / durationInFrames;
  const comparison = screen.layout === LessonLayout.COMPARISON;
  /* Custom visuals reserve a fixed safe rectangle; shorter captions keep wide labels below it. */
  const pages = splitNarration(screen.narration, visualFrames ? 120 : 180);
  const page = Math.min(pages.length - 1, Math.floor(progress * pages.length));
  const visual = visualFrames?.[frame];
  return (
    <AbsoluteFill
      style={{ background: '#f7f5ec', color: '#17372f', fontFamily: 'Noto Sans', padding: 52 }}
    >
      {audioUrl && <Html5Audio src={audioUrl} />}
      <div
        style={{ width: 80, height: 7, borderRadius: 5, background: '#e8ad50', marginBottom: 20 }}
      />
      <h1
        style={{
          fontSize: visual ? 28 : 36,
          lineHeight: 1.25,
          margin: '0 0 28px',
          maxWidth: 1140,
          overflowWrap: 'anywhere',
          opacity: interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      >
        {screen.title}
      </h1>
      {visual ? (
        <div
          style={{
            position: 'absolute',
            left: 52,
            top: 180,
            width: 1176,
            height: 350,
            overflow: 'hidden',
          }}
        >
          <LessonVisual node={visual} />
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: comparison ? '1fr 1fr' : '1fr',
            gap: 14,
            alignContent: 'start',
          }}
        >
          {screen.points.map((point, index) => (
            <div
              key={index}
              style={{
                gridColumn: comparison && index === 2 ? '1 / -1' : undefined,
                background: index % 2 ? '#e9efdf' : '#fffaf0',
                border: '1px solid #cdd7c0',
                borderRadius: 16,
                /* Leave room for three full points and a three-line caption at schema limits. */
                padding: '12px 22px',
                fontSize: comparison ? 23 : 24,
                lineHeight: 1.35,
                overflowWrap: 'anywhere',
                opacity: interpolate(frame, [index * 12 + 8, index * 12 + 20], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                }),
              }}
            >
              {screen.layout === LessonLayout.EXAMPLE && (
                <span style={{ color: '#956a2c', marginRight: 15 }}>{index + 1}.</span>
              )}
              {point}
            </div>
          ))}
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          left: 52,
          right: 52,
          bottom: 34,
          minHeight: 100,
          background: '#17372f',
          color: '#fffaf0',
          borderRadius: 14,
          padding: '18px 24px',
          fontSize: 25,
          lineHeight: 1.45,
          overflowWrap: 'anywhere',
        }}
      >
        {pages[page]}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: 5,
          width: `${String(progress * 100)}%`,
          background: '#e8ad50',
        }}
      />
    </AbsoluteFill>
  );
}
