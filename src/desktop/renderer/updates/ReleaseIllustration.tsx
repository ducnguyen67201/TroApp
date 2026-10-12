import { IconBook, IconChartBar } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { ReleaseIllustration as Illustration } from '../../updates/ReleaseNotes.js';
import { useLocale } from '../localization/UseLocale.js';
import { whatsNewMessages } from './WhatsNewMessages.js';

/** Decorative feature diagrams contain no student records or captured content. */
export function ReleaseIllustration({ kind }: { kind: Illustration }): ReactElement {
  const { locale } = useLocale();
  const text = whatsNewMessages[locale];
  return (
    <div className="whats-new-illustration" aria-hidden="true">
      {kind === Illustration.PRACTICE && (
        <>
          <div className="whats-new-mini-window">
            <div className="whats-new-mini-toolbar">
              <span>{text.practice}</span>
              <span className="whats-new-mini-status">{text.practicing}</span>
            </div>
            <div className="whats-new-code">
              <div>total = 0</div>
              <div>for number in range(1, 5):</div>
              <div>
                &nbsp;&nbsp;&nbsp; <span>total = number</span>
              </div>
              <div>print(total)</div>
            </div>
          </div>
          <div className="whats-new-floating-note whats-new-feedback">
            <IconBook size={16} stroke={1.6} />
            <div>
              <strong>{text.feedbackTitle}</strong>
              {text.feedback}
            </div>
          </div>
        </>
      )}
      {kind === Illustration.INSIGHTS && (
        <>
          <div className="whats-new-mini-window">
            <div className="whats-new-mini-toolbar">
              <span>{text.class}</span>
              <span className="whats-new-mini-status">{text.insights}</span>
            </div>
            <div className="whats-new-insight-body">
              <div className="whats-new-mini-heading">{text.insightHeading}</div>
              <div className="whats-new-journey">
                <span>{text.complete}</span>
                <div>
                  <i />
                </div>
                <span>{text.inProgress}</span>
                <div>
                  <i />
                </div>
                <span>{text.support}</span>
                <div>
                  <i />
                </div>
              </div>
            </div>
          </div>
          <div className="whats-new-floating-note">
            <IconChartBar size={15} stroke={1.6} />
            {text.insightNote}
          </div>
        </>
      )}
    </div>
  );
}
