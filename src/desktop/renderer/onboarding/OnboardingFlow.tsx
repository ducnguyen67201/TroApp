import { Alert, Button, Group, Modal, Portal, Stack, Text, Title } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { useState, type ReactElement, type RefObject } from 'react';
import type { AccountRole } from '#contracts/AccountRole.js';
import {
  OnboardingAction,
  OnboardingStatus,
  OnboardingStep,
  onboardingSteps,
} from '#contracts/OnboardingValues.js';
import { useLocale } from '../localization/UseLocale.js';
import { readOnboardingContent } from './OnboardingContent.js';
import { onboardingMessages } from './OnboardingMessages.js';
import { OnboardingVideo } from './OnboardingVideo.js';
import type { OnboardingView } from './UseOnboarding.js';
import { useOnboardingPosition } from './UseOnboardingPosition.js';
import { useOtherDialog } from './UseOtherDialog.js';

export type OnboardingAnchors = Readonly<
  Record<OnboardingStep, RefObject<HTMLButtonElement | null>>
>;

interface OnboardingFlowProps {
  view: OnboardingView;
  anchors: OnboardingAnchors;
  role: AccountRole | null;
  canPresent: boolean;
}

/** Presentation adapter. Highlights navigation without invoking routes, agent work or permissions. */
export function OnboardingFlow({
  view,
  anchors,
  role,
  canPresent,
}: OnboardingFlowProps): ReactElement {
  const { locale } = useLocale();
  const messages = onboardingMessages[locale];
  const hasOtherDialog = useOtherDialog();
  const reducedMotion = useReducedMotion();
  const [modalRoot, setModalRoot] = useState<HTMLDivElement | null>(null);
  const progress = view.progress;
  const isTour = progress?.status === OnboardingStatus.IN_PROGRESS;
  const isWelcome = progress?.status === OnboardingStatus.NEW;
  const isOpen =
    canPresent &&
    !hasOtherDialog &&
    role !== null &&
    !view.isLoading &&
    (isTour || isWelcome || view.showCompletion);
  const stepId = progress?.stepId ?? OnboardingStep.WORKSPACE;
  const position = useOnboardingPosition(
    isOpen && isTour ? anchors[stepId].current : null,
    modalRoot,
  );
  const content = role ? readOnboardingContent(stepId, locale, role) : null;
  const index = onboardingSteps.indexOf(stepId);
  const isLast = index === onboardingSteps.length - 1;
  const title = isWelcome
    ? messages.welcomeTitle
    : view.showCompletion
      ? messages.completeTitle
      : messages.title;

  function dismiss(): void {
    if (view.showCompletion) {
      view.closeCompletion();
    } else {
      void view.sendAction(OnboardingAction.DISMISS);
    }
  }

  return (
    <>
      {isOpen && isTour && position && (
        <Portal>
          <div aria-hidden="true" className="onboarding-spotlight" style={position.anchor} />
        </Portal>
      )}
      <Modal
        ref={setModalRoot}
        opened={isOpen}
        onClose={dismiss}
        title={title}
        closeButtonProps={{ 'aria-label': messages.close, disabled: view.isSaving }}
        centered={!isTour || !position}
        size={438}
        padding="lg"
        radius="lg"
        zIndex={300}
        returnFocus={false}
        transitionProps={{ duration: reducedMotion ? 0 : 120 }}
        overlayProps={{ backgroundOpacity: 0.3 }}
        classNames={{
          content: 'onboarding-dialog',
          body: 'onboarding-body',
          header: 'onboarding-header',
        }}
        styles={
          isTour && position
            ? {
                content: {
                  position: 'fixed',
                  top: position.top,
                  left: position.left,
                  width: position.width,
                  margin: 0,
                },
              }
            : {}
        }
        onExitTransitionEnd={() => {
          if (canPresent && !hasOtherDialog) {
            anchors[stepId].current?.focus();
          }
        }}
      >
        {isOpen && (
          <Stack gap="md">
            {view.hasError && (
              <Alert role="alert" color="charcoal">
                <Text size="sm">{messages.error}</Text>
                <Button
                  variant="default"
                  size="xs"
                  mt="sm"
                  disabled={view.isSaving}
                  onClick={() => {
                    void view.refresh();
                  }}
                >
                  {messages.retry}
                </Button>
              </Alert>
            )}
            {isWelcome ? (
              <>
                <Text size="sm" c="dimmed">
                  {messages.welcomeBody}
                </Text>
                <Text size="xs" c="dimmed">
                  {messages.welcomeHint}
                </Text>
                <Group justify="space-between" mt="sm">
                  <Button variant="subtle" disabled={view.isSaving} onClick={dismiss}>
                    {messages.skip}
                  </Button>
                  <Button
                    loading={view.isSaving}
                    onClick={() => {
                      void view.sendAction(OnboardingAction.START);
                    }}
                  >
                    {messages.start}
                  </Button>
                </Group>
              </>
            ) : view.showCompletion ? (
              <>
                <Text size="sm" c="dimmed">
                  {messages.completeBody}
                </Text>
                <Button onClick={view.closeCompletion}>{messages.done}</Button>
              </>
            ) : (
              content && (
                <>
                  <Text size="xs" c="dimmed" className="onboarding-step-label" aria-live="polite">
                    {messages.step(index + 1, onboardingSteps.length)}
                  </Text>
                  <OnboardingVideo
                    key={`${stepId}:${locale}:${role}`}
                    stepId={stepId}
                    content={content}
                  />
                  <Title order={3} className="onboarding-title">
                    {content.copy.title}
                  </Title>
                  <Text size="sm" c="dimmed">
                    {content.copy.description}
                  </Text>
                  <Text size="sm" className="onboarding-takeaway">
                    {content.copy.takeaway}
                  </Text>
                  {content.transcript && (
                    <details className="onboarding-transcript">
                      <summary>{messages.transcript}</summary>
                      <Text size="sm" mt="sm">
                        {content.transcript}
                      </Text>
                    </details>
                  )}
                  <Group justify="space-between" className="onboarding-actions">
                    <Button variant="subtle" size="xs" disabled={view.isSaving} onClick={dismiss}>
                      {messages.skip}
                    </Button>
                    <Group gap="xs">
                      <Button
                        variant="default"
                        disabled={index === 0 || view.isSaving}
                        onClick={() => {
                          void view.sendAction(OnboardingAction.BACK);
                        }}
                      >
                        {messages.back}
                      </Button>
                      <Button
                        loading={view.isSaving}
                        onClick={() => {
                          void view.sendAction(OnboardingAction.NEXT);
                        }}
                      >
                        {isLast ? messages.finish : messages.next}
                      </Button>
                    </Group>
                  </Group>
                </>
              )
            )}
          </Stack>
        )}
      </Modal>
    </>
  );
}
