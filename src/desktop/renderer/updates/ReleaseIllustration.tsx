import {
  IconBook,
  IconCheck,
  IconPhoto,
  IconQrcode,
  IconSchool,
  IconUsers,
} from '@tabler/icons-react';
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
      {kind === Illustration.QR_LOGIN && (
        <>
          <div className="whats-new-mini-window">
            <div className="whats-new-mini-toolbar">
              <span>{text.qrLogin}</span>
              <span className="whats-new-mini-status">{text.authorized}</span>
            </div>
            <div className="whats-new-qr-body">
              <div className="whats-new-qr-card">
                <IconQrcode size={70} stroke={1.5} />
                <span>{text.qrCard}</span>
              </div>
              <div className="whats-new-login-result">
                <span className="whats-new-feature-icon">
                  <IconCheck size={24} />
                </span>
                <strong>{text.qrLogin}</strong>
                <span>{text.authorized}</span>
              </div>
            </div>
          </div>
          <div className="whats-new-floating-note">
            <IconBook size={16} stroke={1.6} />
            {text.qrNote}
          </div>
        </>
      )}
      {kind === Illustration.TEAM && (
        <>
          <div className="whats-new-mini-window">
            <div className="whats-new-mini-toolbar">
              <span>{text.team}</span>
              <IconUsers size={14} stroke={1.6} />
            </div>
            <div className="whats-new-team-body">
              <div className="whats-new-member-row">
                <span className="whats-new-avatar">A</span>
                <span className="whats-new-mini-status">{text.teacher}</span>
                <span className="whats-new-avatar">B</span>
                <span className="whats-new-mini-status">{text.student}</span>
              </div>
              <div className="whats-new-class-assignment">
                <IconBook size={22} stroke={1.5} />
                <div>
                  <strong>{text.class}</strong>
                  <span>{text.assigned}</span>
                </div>
                <span className="whats-new-avatar">A</span>
                <span className="whats-new-avatar">C</span>
              </div>
            </div>
          </div>
          <div className="whats-new-floating-note">
            <IconCheck size={15} stroke={1.6} />
            {text.teamNote}
          </div>
        </>
      )}
      {kind === Illustration.ORGANIZATION_LOGO && (
        <>
          <div className="whats-new-mini-window">
            <div className="whats-new-mini-toolbar">
              <span>{text.team}</span>
              <span className="whats-new-mini-status">{text.logo}</span>
            </div>
            <div className="whats-new-logo-body">
              <div className="whats-new-logo-sidebar">
                <span className="whats-new-school-logo">
                  <IconSchool size={30} stroke={1.5} />
                </span>
                <span className="whats-new-sidebar-line" />
                <span className="whats-new-sidebar-line" />
                <span className="whats-new-sidebar-line" />
              </div>
              <div className="whats-new-logo-settings">
                <strong>{text.organization}</strong>
                <span className="whats-new-school-logo">
                  <IconSchool size={30} stroke={1.5} />
                </span>
                <span className="whats-new-logo-upload">
                  <IconPhoto size={13} />
                  {text.changeLogo}
                </span>
              </div>
            </div>
          </div>
          <div className="whats-new-floating-note">
            <IconCheck size={15} stroke={1.6} />
            {text.logoNote}
          </div>
        </>
      )}
    </div>
  );
}
