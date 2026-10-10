import { useEffect } from 'react';
import {
  AbsoluteFill,
  Html5Audio,
  Html5Video,
  Img,
  Sequence,
  getRemotionEnvironment,
  useCurrentFrame,
  useDelayRender,
} from 'remotion';
import type { LearnerProjection, VisibleTraceState } from '../contracts/GuidedLessons.js';
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-700.css';
import '@fontsource/noto-sans/vietnamese-400.css';
import '@fontsource/noto-sans/vietnamese-700.css';
import '@fontsource/noto-sans-mono/latin-400.css';
import '@fontsource/noto-sans-mono/latin-700.css';

export interface LessonCompositionProps {
  projection: LearnerProjection;
  audioSources: Record<string, string>;
  sourceAssets: Record<string, string>;
}

/** A single trusted presentation for teacher review, rendered evidence and home playback. */
export function LessonComposition({
  projection,
  audioSources,
  sourceAssets,
}: LessonCompositionProps) {
  const frame = useCurrentFrame();
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  useEffect(() => {
    const handle = delayRender('Load bundled lesson fonts');
    let active = true;
    void Promise.all([
      document.fonts.load('48px "Noto Sans"'),
      document.fonts.load('700 48px "Noto Sans"'),
      document.fonts.load('48px "Noto Sans Mono"'),
      document.fonts.load('700 48px "Noto Sans Mono"'),
    ]).then(
      () => {
        if (active) {
          if (getRemotionEnvironment().isRendering) {
            const geometry = Array.from(
              document.querySelectorAll<HTMLElement>('[data-lesson-essential]'),
            ).map((element) => {
              const bounds = element.getBoundingClientRect();
              return {
                fontPx: Number.parseFloat(getComputedStyle(element).fontSize),
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight,
              };
            });
            console.info('tro.lesson.geometry:' + JSON.stringify(geometry));
          }
          continueRender(handle);
        }
      },
      () => {
        if (active) {
          cancelRender(new Error('Lesson fonts could not load.'));
        }
      },
    );
    return () => {
      active = false;
      continueRender(handle);
    };
  }, [delayRender, continueRender, cancelRender, frame]);
  const state = readVisibleState(projection, frame);
  const presentation = projection.presentation;
  const code = presentation.kind === 'annotatedSource' ? null : presentation.codeBlock;
  const figure = presentation.kind === 'codeTrace' ? null : presentation.figure;
  const figureSource = figure ? sourceAssets[figure.assetId] : undefined;
  const focusVariable = presentation.kind === 'annotatedSource' ? null : presentation.focusVariable;
  const wideCode = projection.sceneAdjustment.layoutVariant === 'wideCode';
  const sideCaption = projection.sceneAdjustment.captionPlacement === 'reservedSide';
  const caption =
    projection.narrationCues.find((cue) => frame >= cue.startFrame && frame < cue.endFrame)?.text ??
    '';
  const activeIndex = Math.max(
    0,
    code?.lines.findIndex((line) => line.lineId === state?.lineId) ?? 0,
  );
  const firstLine = Math.max(0, Math.min(activeIndex - 3, (code?.lines.length ?? 0) - 8));
  const isVietnamese = /[ăâđêôơưạảấầệịọộớờự]/i.test(projection.sceneTitle + caption);
  const video = projection.videoArtifactId ? sourceAssets[projection.videoArtifactId] : undefined;
  if (projection.videoArtifactId) {
    return (
      <AbsoluteFill style={{ background: '#f6f3eb' }}>
        {video && (
          <Html5Video
            src={video}
            muted
            pauseWhenBuffering
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
        {projection.narrationCues.map((cue) =>
          audioSources[cue.artifactId] ? (
            <Sequence
              key={cue.cueId}
              from={cue.startFrame}
              durationInFrames={cue.endFrame - cue.startFrame}
            >
              <Html5Audio src={audioSources[cue.artifactId]} pauseWhenBuffering />
            </Sequence>
          ) : null,
        )}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill
      className="tro-lesson-canvas"
      style={{
        background: '#f6f3eb',
        color: '#172f28',
        fontFamily: 'Noto Sans',
        lineHeight: 1.3,
        letterSpacing: 'normal',
        fontWeight: 400,
        textTransform: 'none',
        padding: 60,
        boxSizing: 'border-box',
      }}
    >
      <style>{'.tro-lesson-canvas, .tro-lesson-canvas * { box-sizing: border-box; }'}</style>
      <div
        data-lesson-essential
        style={{
          flexShrink: 0,
          fontSize: 48,
          fontWeight: 700,
          height: 130,
          lineHeight: 1.2,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {projection.sceneTitle}
      </div>
      <div style={{ display: 'flex', flexShrink: 0, gap: 40, height: sideCaption ? 800 : 620 }}>
        <div
          style={{
            width: code ? (wideCode ? 1220 : 1100) : 1800,
            background: '#ffffff',
            borderRadius: 24,
            border: '2px solid #d0d9d2',
            padding: 28,
            overflow: 'hidden',
            boxSizing: 'border-box',
            position: 'relative',
          }}
        >
          {code ? (
            code.lines.slice(firstLine, firstLine + 8).map((line, index) => (
              <div
                key={line.lineId}
                data-lesson-essential
                style={{
                  whiteSpace: 'pre',
                  display: 'flex',
                  fontFamily: 'Noto Sans Mono',
                  fontSize: 48,
                  lineHeight: '68px',
                  borderRadius: 12,
                  background: state?.lineId === line.lineId ? '#f4bd65' : 'transparent',
                  color: '#172f28',
                }}
              >
                <span
                  style={{
                    width: 85,
                    flexShrink: 0,
                    textAlign: 'right',
                    paddingRight: 24,
                    color: '#172f28',
                  }}
                >
                  {firstLine + index + 1}
                </span>
                <span>{line.text}</span>
              </div>
            ))
          ) : figure && figureSource ? (
            <>
              <Img
                src={figureSource}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
              {figure.callouts.map((callout) => (
                <div
                  data-lesson-essential
                  key={callout.calloutId}
                  style={{
                    position: 'absolute',
                    left: `${String(Math.min(0.7, Math.max(0.02, callout.x)) * 100)}%`,
                    top: `${String(Math.min(0.8, Math.max(0.02, callout.y)) * 100)}%`,
                    maxWidth: '28%',
                    fontSize: 48,
                    lineHeight: 1.15,
                    padding: 12,
                    borderRadius: 12,
                    background: '#f4bd65',
                    color: '#172f28',
                  }}
                >
                  {callout.label}
                </div>
              ))}
            </>
          ) : (
            <div data-lesson-essential style={{ fontSize: 48, lineHeight: 1.3, padding: 30 }}>
              {projection.checkpoint?.question ?? projection.sceneTitle}
            </div>
          )}
        </div>
        {code && (
          <div
            style={{
              width: wideCode ? 540 : 660,
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {(state?.values ?? []).map((binding) => (
              <div
                key={binding.name}
                data-lesson-essential
                style={{
                  background: binding.name === focusVariable ? '#a8e2bf' : '#f4bd65',
                  borderRadius: 20,
                  padding: '20px 28px',
                  fontSize: 48,
                  minHeight: 85,
                  boxSizing: 'border-box',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 20,
                }}
              >
                <span>{binding.name}</span>
                <strong>
                  {Array.isArray(binding.value) ? `[${binding.value.join(', ')}]` : binding.value}
                </strong>
              </div>
            ))}
            {state?.output !== null && state?.output !== undefined && (
              <div
                data-lesson-essential
                style={{ fontSize: 48, background: '#ffffff', padding: 28, borderRadius: 20 }}
              >
                {isVietnamese ? 'Kết quả' : 'Output'}: <strong>{state.output}</strong>
              </div>
            )}
            {sideCaption && (
              <div
                data-lesson-essential
                style={{ fontSize: 48, lineHeight: 1.25, padding: 24, overflow: 'hidden' }}
              >
                {caption}
              </div>
            )}
            {projection.checkpoint && (
              <div
                data-lesson-essential
                style={{
                  fontSize: 48,
                  lineHeight: 1.25,
                  padding: 24,
                  background: '#e5ebe6',
                  borderRadius: 20,
                  overflow: 'hidden',
                }}
              >
                {projection.checkpoint.question}
              </div>
            )}
          </div>
        )}
      </div>
      {!sideCaption && (
        <div
          data-lesson-essential
          style={{
            flexShrink: 0,
            marginTop: 30,
            height: 180,
            boxSizing: 'border-box',
            borderTop: '2px solid #c5d0c7',
            paddingTop: 24,
            fontSize: 48,
            lineHeight: 1.25,
            overflow: 'hidden',
          }}
        >
          {caption}
        </div>
      )}
      {projection.narrationCues.map((cue) =>
        audioSources[cue.artifactId] ? (
          <Sequence
            key={cue.cueId}
            from={cue.startFrame}
            durationInFrames={cue.endFrame - cue.startFrame}
          >
            <Html5Audio
              src={audioSources[cue.artifactId]}
              pauseWhenBuffering
              acceptableTimeShiftInSeconds={0.1}
            />
          </Sequence>
        ) : null,
      )}
    </AbsoluteFill>
  );
}

export function readLessonDurationFrames(projection: LearnerProjection): number {
  return Math.max(
    30,
    ...projection.narrationCues.map((cue) => cue.endFrame),
    ...projection.visualCues.map((cue) => cue.endFrame),
  );
}

export function readVisibleState(
  projection: LearnerProjection,
  frame: number,
): VisibleTraceState | undefined {
  const cue = projection.visualCues.find(
    (item) => frame >= item.startFrame && frame < item.endFrame,
  );
  return (
    projection.visibleTraceStates.find(
      (state) => state.eventId === cue?.eventId && state.stateView === cue.stateView,
    ) ?? projection.visibleTraceStates[0]
  );
}
