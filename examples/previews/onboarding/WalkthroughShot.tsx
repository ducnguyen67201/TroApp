import type { ReactElement } from 'react';
import {
  AbsoluteFill,
  CanvasImage,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { TroPalette } from '../../../src/desktop/DesktopAppearance.js';
import { onboardingShots, ShotKind, videoTopics, type ShotId } from './VideoContent.js';
import { KeyboardArt, PetArt, TopicIcon, VideoCursor } from './VideoArt.js';
import { videoNarration } from './VideoNarration.js';

/** Shared frame template. Editorial content and timing are independent of Remotion. */
export function WalkthroughShot({
  shotId,
  step,
  stepCount = 4,
  durationSeconds = 2.5,
}: {
  shotId: ShotId;
  step: number;
  stepCount?: number;
  durationSeconds?: number;
}): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shot = onboardingShots[shotId];
  const topic = videoTopics[shot.topic];
  const entrance = spring({ frame, fps, config: { damping: 28, stiffness: 125 } });
  const crop = shot.crop;
  const intro = shot.kind === ShotKind.INTRO;
  const displayWidth = 720;
  const displayHeight = 425;
  const imageScale = Math.min(displayWidth / crop.width, displayHeight / crop.height);
  const imageX = (displayWidth - crop.width * imageScale) / 2;
  const imageY = (displayHeight - crop.height * imageScale) / 2;
  const duration = Math.round(durationSeconds * fps);
  return (
    <AbsoluteFill
      data-shot={shotId}
      style={{
        backgroundColor: TroPalette.CREAM,
        color: TroPalette.BLACK,
        fontFamily: 'Noto Sans, sans-serif',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 350,
          height: 350,
          borderRadius: '50%',
          border: '1px solid #E8DECC',
          right: -135,
          top: -180,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 64,
          right: 64,
          top: 36,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <CanvasImage
          src={staticFile('Brand/TroMark.png')}
          premountFor={fps}
          style={{ width: 44, height: 44, objectFit: 'contain' }}
        />
        <span style={{ fontSize: 25, fontWeight: 700 }}>Tro</span>
        <span style={{ height: 22, borderLeft: '1px solid #DCD4C7', marginLeft: 8 }} />
        <span style={{ fontSize: 20, color: TroPalette.CHARCOAL }}>{topic.title}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
          {Array.from({ length: stepCount }, (_, index) => index + 1).map((item) => (
            <span
              key={item}
              style={{
                width: item === step ? 34 : 8,
                height: 8,
                borderRadius: 8,
                background: item === step ? TroPalette.ORANGE : '#DDD5C8',
              }}
            />
          ))}
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 64,
          top: 148,
          width: 386,
          translate: `${String((1 - entrance) * -26)}px 0`,
          opacity: entrance,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: intro ? 72 : 48,
            height: intro ? 72 : 48,
            borderRadius: 20,
            background: '#FFE4D3',
            color: '#B94617',
            marginBottom: 22,
          }}
        >
          {intro ? (
            <TopicIcon topic={shot.topic} size={40} />
          ) : (
            <span style={{ fontSize: 24, fontWeight: 700 }}>
              {String(step - 1).padStart(2, '0')}
            </span>
          )}
        </div>
        <h1
          data-video-title
          style={{
            fontSize: intro ? 59 : 54,
            lineHeight: 1.14,
            letterSpacing: -2.2,
            fontWeight: 700,
            whiteSpace: 'pre-line',
            margin: '0 0 24px',
          }}
        >
          {shot.title}
        </h1>
        <p
          data-video-detail
          style={{
            fontSize: 25,
            lineHeight: 1.5,
            color: TroPalette.CHARCOAL,
            whiteSpace: 'pre-line',
            margin: 0,
          }}
        >
          {shot.detail}
        </p>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 496,
          top: 143,
          width: displayWidth,
          height: displayHeight,
          borderRadius: 24,
          overflow: 'hidden',
          background: intro ? '#F1EADA' : '#F7F2E7',
          boxShadow: '0 18px 55px #66512A14',
          translate: `0 ${String((1 - entrance) * 28)}px`,
          scale: interpolate(frame, [0, duration], [intro ? 0.97 : 1, intro ? 1 : 1.015], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        {shot.screen && (
          <div
            style={{
              position: 'absolute',
              left: imageX,
              top: imageY,
              width: crop.width * imageScale,
              height: crop.height * imageScale,
              overflow: 'hidden',
              borderRadius: intro ? 16 : 8,
            }}
          >
            <CanvasImage
              src={staticFile(`Screens/${shot.screen}`)}
              premountFor={fps}
              style={{
                position: 'absolute',
                width: 1280 * imageScale,
                height: 800 * imageScale,
                maxWidth: 'none',
                left: -crop.x * imageScale,
                top: -crop.y * imageScale,
              }}
            />
          </div>
        )}
        {shot.screen && (
          <VideoCursor
            x={imageX + (shot.pointer.x - crop.x) * imageScale}
            y={imageY + (shot.pointer.y - crop.y) * imageScale}
          />
        )}
        {shot.kind === ShotKind.KEYBOARD && <KeyboardArt />}
        {shot.kind === ShotKind.PET && <PetArt />}
      </div>
      <div
        data-video-action
        style={{
          position: 'absolute',
          left: 522,
          right: 78,
          top: 580,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 20,
          lineHeight: 1.3,
          color: TroPalette.CHARCOAL,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: TroPalette.ORANGE }} />
        {shot.action}
        <span style={{ marginLeft: 'auto', fontSize: 14, color: '#817A6D' }}>
          {shot.screen ? 'Dữ liệu mẫu · Giọng AI' : 'Minh họa · Giọng AI'}
        </span>
      </div>
      <div
        data-video-caption
        style={{
          position: 'absolute',
          left: 64,
          right: 64,
          top: 612,
          borderTop: '1px solid #DED6C7',
          paddingTop: 14,
        }}
      >
        <p
          data-video-narration
          style={{ margin: 0, fontSize: 24, lineHeight: 1.45, maxWidth: 1140 }}
        >
          {videoNarration[shot.topic].text}
        </p>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          height: 4,
          width: `${String(Math.min(100, (frame / (duration - 1)) * 100))}%`,
          background: TroPalette.ORANGE,
        }}
      />
    </AbsoluteFill>
  );
}
