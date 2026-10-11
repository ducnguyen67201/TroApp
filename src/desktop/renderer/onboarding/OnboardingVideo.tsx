import { Alert, Button, Text } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useEffect, useState, type ReactElement } from 'react';
import type { OnboardingStep } from '#contracts/OnboardingValues.js';
import type { ResolvedOnboardingContent } from '../../onboarding/domain/OnboardingContent.js';
import { desktopLocales } from '../localization/Locale.js';
import { useLocale } from '../localization/UseLocale.js';
import { onboardingMessages } from './OnboardingMessages.js';

interface OnboardingVideoProps {
  stepId: OnboardingStep;
  content: ResolvedOnboardingContent;
}

/** Native user-controlled playback. Unmount, locale changes and hidden windows pause media. */
export function OnboardingVideo({ stepId, content }: OnboardingVideoProps): ReactElement {
  const { locale } = useLocale();
  const messages = onboardingMessages[locale];
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const [hasError, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    function pauseWhenHidden(): void {
      if (document.hidden) {
        videoElement?.pause();
      }
    }

    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      videoElement?.pause();
    };
  }, [videoElement]);
  const video = content.video;
  const videoLocale = content.videoLocale;
  if (!video || !videoLocale) {
    return (
      <div className="onboarding-video-empty">
        <IconPlayerPlay size={29} stroke={1.3} aria-hidden="true" />
        <Text size="sm">{messages.videoUnavailable}</Text>
      </div>
    );
  }
  return (
    <div className="onboarding-media">
      {videoLocale !== locale && (
        <Text size="xs" className="onboarding-video-language">
          {messages.fallbackVideo(desktopLocales[videoLocale].label)}
        </Text>
      )}
      {hasError ? (
        <Alert role="alert" color="charcoal">
          <Text size="sm">{messages.videoFailed}</Text>
          <Button
            variant="default"
            size="xs"
            mt="sm"
            onClick={() => {
              setAttempt((current) => current + 1);
              setError(false);
            }}
          >
            {messages.retryVideo}
          </Button>
        </Alert>
      ) : (
        <video
          key={`${video.source}:${String(attempt)}`}
          ref={setVideoElement}
          controls
          playsInline
          preload="metadata"
          src={video.source}
          poster={video.poster}
          aria-label={messages.videoLabel}
          onError={() => {
            console.warn('onboarding.video.failed', {
              stage: 'playback',
              stepId,
              locale: videoLocale,
            });
            setError(true);
          }}
        >
          {video.captions && (
            <track
              kind="captions"
              src={video.captions}
              srcLang={videoLocale}
              label={desktopLocales[videoLocale].label}
              default
            />
          )}
        </video>
      )}
    </div>
  );
}
