import { useEffect, useRef, useState, type ReactElement } from 'react';

/** The media source changes only with the artifact ID, never with status polling. */
export function LessonVideoPlayer({
  lessonId,
  artifactId,
  vi,
}: {
  lessonId: string;
  artifactId: string;
  vi: boolean;
}): ReactElement {
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void window.tro
      .readLessonMedia?.({ id: lessonId, artifactId, download: false })
      .then((reply) => {
        if (!alive) {
          return;
        }
        if (reply.kind !== 'media') {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(reply.bytes)], { type: 'video/mp4' }),
        );
        setUrl(objectUrl);
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
        }
      });
    return () => {
      alive = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [lessonId, artifactId]);
  if (failed) {
    return (
      <p role="alert">
        {vi
          ? 'Không tải được video. Hãy mở lại bài giảng.'
          : 'Video could not load. Reopen the lesson to retry.'}
      </p>
    );
  }
  if (!url) {
    return <p role="status">{vi ? 'Đang tải video…' : 'Loading video…'}</p>;
  }
  return (
    <div className="lesson-player">
      <video
        ref={video}
        src={url}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration);
        }}
        onPlay={() => {
          setPlaying(true);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onError={() => {
          setFailed(true);
        }}
      />
      <div className="lesson-player-controls">
        <input
          aria-label={vi ? 'Vị trí phát' : 'Playback position'}
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={time}
          onChange={(event) => {
            if (video.current) {
              video.current.currentTime = Number(event.target.value);
            }
          }}
        />
        <div>
          <button
            onClick={() => {
              if (!video.current) {
                return;
              }
              if (playing) {
                video.current.pause();
              } else {
                void video.current.play().catch(() => {
                  setFailed(true);
                });
              }
            }}
          >
            {playing ? (vi ? 'Tạm dừng' : 'Pause') : vi ? 'Phát' : 'Play'}
          </button>
          <button
            aria-label={vi ? 'Lùi 5 giây' : 'Back 5 seconds'}
            onClick={() => {
              if (video.current) {
                video.current.currentTime = Math.max(0, time - 5);
              }
            }}
          >
            −5s
          </button>
          <button
            aria-label={vi ? 'Tiến 5 giây' : 'Forward 5 seconds'}
            onClick={() => {
              if (video.current) {
                video.current.currentTime = Math.min(duration, time + 5);
              }
            }}
          >
            +5s
          </button>
          <span>
            {Math.floor(time)} / {Math.floor(duration)}s
          </span>
          <input
            aria-label={vi ? 'Âm lượng' : 'Volume'}
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={1}
            onChange={(event) => {
              if (video.current) {
                video.current.volume = Number(event.target.value);
              }
            }}
          />
          <button
            onClick={() => {
              void video.current?.requestFullscreen();
            }}
          >
            {vi ? 'Toàn màn hình' : 'Fullscreen'}
          </button>
        </div>
      </div>
    </div>
  );
}
