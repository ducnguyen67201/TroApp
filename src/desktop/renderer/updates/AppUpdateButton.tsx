import { UnstyledButton } from '@mantine/core';
import { IconDownload, IconRefresh, IconAlertCircle } from '@tabler/icons-react';
import { useId, type ReactElement } from 'react';
import { AppUpdatePhase, AppUpdateState } from '#contracts/AppUpdate.js';
import { useLocale } from '../localization/UseLocale.js';
import { useAppUpdate } from './UseAppUpdate.js';

/** The full sidebar-width action stays above settings and survives sign-out. */
export function AppUpdateButton({ isBusy }: { isBusy: boolean }): ReactElement | null {
  const update = useAppUpdate();
  const { messages, locale } = useLocale();
  const detailId = useId();
  const { status } = update;
  if (
    status.state === AppUpdateState.DISABLED ||
    status.state === AppUpdateState.CURRENT ||
    status.state === AppUpdateState.CHECKING
  ) {
    return null;
  }

  let title = messages.updateTro;
  let detail = messages.updateAvailable(status.version ?? '');
  let Icon = IconDownload;
  const isDownloading = status.state === AppUpdateState.DOWNLOADING;
  const isRestarting = status.state === AppUpdateState.RESTARTING;
  const shouldRestart =
    status.state === AppUpdateState.READY ||
    (status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.INSTALL);
  if (isDownloading) {
    title = messages.updateDownloading;
    detail = messages.updateKeepUsing;
    Icon = IconRefresh;
  } else if (shouldRestart) {
    title = messages.updateRestart;
    detail = isBusy ? messages.updateBusy : messages.updateReady(status.version ?? '');
    Icon = IconRefresh;
  } else if (isRestarting) {
    title = messages.updateRestarting;
    detail = messages.updateInstalling;
    Icon = IconRefresh;
  }
  if (status.state === AppUpdateState.ERROR) {
    title =
      status.phase === AppUpdatePhase.INSTALL ? messages.updateRetryRestart : messages.updateRetry;
    detail =
      status.phase === AppUpdatePhase.CHECK
        ? messages.updateCheckFailed
        : status.phase === AppUpdatePhase.INSTALL
          ? messages.updateInstallFailed
          : messages.updateDownloadFailed;
    Icon = IconAlertCircle;
  }
  const percent = isDownloading
    ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
        status.percent / 100,
      )
    : null;

  return (
    <div className="sidebar-update">
      <UnstyledButton
        className="sidebar-update-button"
        data-state={status.state}
        aria-describedby={detailId}
        disabled={update.isRequesting || isDownloading || isRestarting || (shouldRestart && isBusy)}
        onClick={() => {
          void update.applyUpdate();
        }}
      >
        <Icon className="sidebar-update-icon" size={19} stroke={1.7} aria-hidden="true" />
        <span className="sidebar-update-copy">
          <span className="sidebar-update-title">{title}</span>
          <span className="sidebar-update-detail" id={detailId}>
            {detail}
          </span>
        </span>
        {percent && (
          <span className="sidebar-update-percent" aria-hidden="true">
            {percent}
          </span>
        )}
      </UnstyledButton>
      {isDownloading && (
        <progress
          className="sidebar-update-progress"
          value={status.percent}
          max={100}
          aria-label={messages.updateProgress}
        />
      )}
      <span
        className="sidebar-update-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {title}. {detail}
      </span>
      {update.message && (
        <p className="sidebar-update-feedback" role="alert">
          {update.message}
        </p>
      )}
    </div>
  );
}
