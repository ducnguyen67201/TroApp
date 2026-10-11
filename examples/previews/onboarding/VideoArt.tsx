import type { ReactElement } from 'react';
import {
  IconSchool,
  IconChartBar,
  IconPlayerPlay,
  IconMicrophone,
  IconPaw,
} from '@tabler/icons-react';
import {
  CanvasImage,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { TroPalette } from '../../../src/desktop/DesktopAppearance.js';
import { VideoTopic, videoTopics } from './VideoContent.js';

export function TopicIcon({
  topic,
  size = 44,
}: {
  topic: VideoTopic;
  size?: number;
}): ReactElement {
  const icons = {
    school: IconSchool,
    chart: IconChartBar,
    play: IconPlayerPlay,
    microphone: IconMicrophone,
    paw: IconPaw,
  };
  const Icon = icons[videoTopics[topic].icon];
  return <Icon size={size} stroke={1.5} />;
}

/** Cursor and click ring are pure functions of the local shot frame. */
export function VideoCursor({ x, y }: { x: number; y: number }): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const arrival = spring({
    frame: frame - fps * 0.45,
    fps,
    config: { damping: 28, stiffness: 110 },
  });
  const click = interpolate(frame, [fps * 0.355, fps * 1.75], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: x + (1 - arrival) * 90,
        top: y + (1 - arrival) * 90,
        opacity: arrival,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 72,
          height: 72,
          left: -36,
          top: -36,
          borderRadius: '50%',
          border: `3px solid ${TroPalette.ORANGE}`,
          opacity: 1 - click,
          scale: 0.5 + click,
        }}
      />
      <svg
        width="37"
        height="43"
        viewBox="0 0 37 43"
        style={{ filter: 'drop-shadow(0px 2px 2px #25242225)' }}
      >
        <path
          d="M3 2L31 23L18 25L13 38Z"
          fill={TroPalette.BLACK}
          stroke="white"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function KeyboardArt(): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const windows = frame >= fps * 3.8;
  const keyboardSeconds = frame / fps - (windows ? 3.8 : 0);
  const held = keyboardSeconds > 0.35 && keyboardSeconds < 2.4;
  return (
    <div
      style={{
        width: 720,
        height: 420,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {(windows ? ['Control', 'Alt trái'] : ['⌘', 'Control']).map((key) => (
          <div
            key={key}
            style={{
              minWidth: 160,
              height: 120,
              padding: '0 24px',
              borderRadius: 22,
              border: `2px solid ${held ? TroPalette.ORANGE : '#DCD4C7'}`,
              background: held ? '#FFE5D6' : '#FFFDF7',
              boxShadow: `0 ${String(held ? 3 : 10)}px 0 #DDD5C9`,
              color: TroPalette.BLACK,
              fontSize: key === '⌘' ? 70 : 36,
              display: 'grid',
              placeItems: 'center',
              translate: `0 ${String(held ? 7 : 0)}px`,
            }}
          >
            {key}
          </div>
        ))}
      </div>
      <div style={{ height: 55, display: 'flex', alignItems: 'center', gap: 7 }}>
        {Array.from({ length: 28 }, (_, index) => (
          <div
            key={index}
            style={{
              width: 6,
              height: held ? 8 + Math.abs(Math.sin(frame / 8 + index * 1.8)) * 35 : 5,
              borderRadius: 6,
              background: held ? TroPalette.ORANGE : TroPalette.GRAY,
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700 }}>
        {keyboardSeconds < 0.35
          ? 'Nhấn giữ phím'
          : held
            ? '“Giải thích vòng lặp giúp mình nhé.”'
            : 'Thả phím để gửi yêu cầu'}
      </div>
      <div style={{ fontSize: 21, color: TroPalette.CHARCOAL }}>
        {windows ? 'Windows · Control + Alt bên trái' : 'Mac · Command + Control'}
      </div>
    </div>
  );
}

export function PetArt(): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const move = spring({ frame: frame - fps * 0.35, fps, config: { damping: 28, stiffness: 75 } });
  const x = 110 + move * 250;
  const happy = frame > fps * 1.65;
  return (
    <div style={{ position: 'relative', width: 720, height: 420, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: 85,
          top: 285,
          width: 535,
          borderBottom: '2px dashed #D8CFC2',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: x,
          top: 34,
          width: 250,
          height: 250,
          overflow: 'hidden',
        }}
      >
        <CanvasImage
          src={staticFile('Brand/FoxReactions.webp')}
          premountFor={fps}
          style={{
            position: 'absolute',
            width: 750,
            height: 750,
            maxWidth: 'none',
            left: happy ? 0 : -250,
            top: -250,
          }}
        />
      </div>
      <VideoCursor x={x + 136} y={240} />
      <div
        style={{
          position: 'absolute',
          left: 110,
          right: 60,
          bottom: 55,
          display: 'flex',
          gap: 14,
          justifyContent: 'center',
        }}
      >
        {['Kéo', 'Thả', 'Vuốt ve'].map((label, index) => (
          <div
            key={label}
            style={{
              fontSize: 28,
              fontWeight: 600,
              padding: '12px 23px',
              borderRadius: 40,
              background: frame / fps > index * 0.65 + 0.3 ? '#FFE5D6' : '#F0EBE0',
            }}
          >
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
