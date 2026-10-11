import { Modal } from '@mantine/core';
import { IconArrowLeft, IconArrowRight, IconCheck } from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AppReleaseNotes } from '../../updates/ReleaseNotes.js';
import { useLocale } from '../localization/UseLocale.js';
import { TroIcon } from '../TroIcon.js';
import { ReleaseIllustration } from './ReleaseIllustration.js';
import { whatsNewMessages } from './WhatsNewMessages.js';
import './WhatsNew.css';

interface WhatsNewDialogProps {
  opened: boolean;
  onClose: () => void;
  onPresented: () => void;
  onExitTransitionEnd: () => void;
  stackId: string;
  release: AppReleaseNotes | null;
  didFailToSave: boolean;
}

/** A replayable, localized tour. Presentation records a view, including when the
 * user closes early; navigating slides does not record additional impressions. */
export function WhatsNewDialog({
  opened,
  onClose,
  onPresented,
  onExitTransitionEnd,
  stackId,
  release,
  didFailToSave,
}: WhatsNewDialogProps): ReactElement {
  const { locale } = useLocale();
  const text = whatsNewMessages[locale];
  const [slideIndex, setSlideIndex] = useState(0);
  const nextButton = useRef<HTMLButtonElement>(null);
  const highlight = release?.highlights[slideIndex];
  const content = highlight?.text[locale];
  const slideCount = release?.highlights.length ?? 0;
  const isLastSlide = slideIndex === slideCount - 1;

  useEffect(() => {
    if (opened) {
      setSlideIndex(0);
      if (release && release.highlights.length > 0) {
        onPresented();
      }
    }
  }, [opened, release, onPresented]);

  function showSlide(index: number): void {
    const nextIndex = Math.max(0, Math.min(slideCount - 1, index));
    if (nextIndex === 0 && document.activeElement?.id === 'whats-new-previous') {
      nextButton.current?.focus();
    }
    setSlideIndex(nextIndex);
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      onExitTransitionEnd={onExitTransitionEnd}
      stackId={stackId}
      returnFocus={false}
      title={
        <div className="whats-new-brand">
          <TroIcon size={27} />
          <span />
          {text.title}
        </div>
      }
      closeButtonProps={{ 'aria-label': text.close }}
      centered
      size={604}
      padding={0}
      radius={20}
      classNames={{
        content: 'whats-new-dialog',
        header: 'whats-new-header',
        body: 'whats-new-body',
      }}
      overlayProps={{ backgroundOpacity: 0.4, blur: 3 }}
    >
      <div
        onKeyDown={(event) => {
          if (slideCount > 0 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            showSlide(slideIndex + (event.key === 'ArrowRight' ? 1 : -1));
          }
        }}
      >
        {highlight && content ? (
          <>
            <section className="whats-new-slide" aria-labelledby="whats-new-heading">
              <ReleaseIllustration kind={highlight.illustration} />
              <div className="whats-new-copy">
                <p className="whats-new-feature-label">{content.label}</p>
                <h2 id="whats-new-heading">{content.title}</h2>
                <p className="whats-new-description">{content.description}</p>
              </div>
            </section>
            <nav className="whats-new-pagination" aria-label={text.highlights}>
              {release.highlights.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className="whats-new-page-dot"
                  aria-label={`${String(index + 1)}. ${item.text[locale].label}`}
                  aria-current={index === slideIndex ? 'step' : undefined}
                  onClick={() => {
                    showSlide(index);
                  }}
                />
              ))}
            </nav>
            <p className="whats-new-sr-only" aria-live="polite" aria-atomic="true">
              {slideIndex + 1} / {slideCount}. {content.title}
            </p>
          </>
        ) : (
          <p className="whats-new-empty">{text.empty}</p>
        )}
        <footer className="whats-new-footer">
          {content && (
            <div className="whats-new-actions">
              <button
                id="whats-new-previous"
                type="button"
                className="whats-new-action"
                disabled={slideIndex === 0}
                onClick={() => {
                  showSlide(slideIndex - 1);
                }}
              >
                <IconArrowLeft size={15} aria-hidden="true" />
                {text.previous}
              </button>
              <button
                ref={nextButton}
                data-autofocus
                type="button"
                className="whats-new-action whats-new-primary"
                onClick={() => {
                  if (isLastSlide) {
                    onClose();
                  } else {
                    showSlide(slideIndex + 1);
                  }
                }}
              >
                {isLastSlide ? text.finish : text.next}
                <IconArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="whats-new-footer-meta">
            <span>
              <IconCheck size={12} aria-hidden="true" />
              {release ? `${text.release} · Tro ${release.version}` : 'Tro'}
              {content && (
                <span>
                  &nbsp; / &nbsp; {slideIndex + 1} / {slideCount}
                </span>
              )}
            </span>
            <button type="button" className="whats-new-skip" onClick={onClose}>
              {text.skip}
            </button>
          </div>
          {didFailToSave && (
            <p className="whats-new-save-error" role="status">
              {text.saveFailed}
            </p>
          )}
        </footer>
      </div>
    </Modal>
  );
}
