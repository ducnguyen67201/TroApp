import { AgentProgressPhase } from '#contracts/CompanionHud.js';
import {
  Button,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { IconArrowUp, IconBrandGoogle, IconPlus } from '@tabler/icons-react';
import { TroIcon } from './TroIcon.js';
import type { ReactElement } from 'react';
import { AgentTaskMode, AgentTaskModeSchema } from '#contracts/CursorCompanion.js';
import { useLocale } from './localization/UseLocale.js';
import { TeachingOutcomeLabel } from './TeachingResultPresentation.js';
import { MessageRole, type ComputerUseController } from './UseComputerUse.js';
import { CompletionMode, TaskOutcomeStatus } from '#contracts/TaskOutcome.js';

interface ComputerUsePageProps {
  controller: ComputerUseController;
}

/** The workspace uses the existing worker bridge; it never calls models directly. */
export function ComputerUsePage({ controller }: ComputerUsePageProps): ReactElement {
  const { messages: translations } = useLocale();
  const { user, isLoading, isSigning, isSending, isSigningOut, isResetting, messages } = controller;
  const firstName = user?.name.trim().split(/\s+/)[0];
  const outcomeLabels = {
    [TaskOutcomeStatus.SUCCEEDED]: translations.taskSucceeded,
    [TaskOutcomeStatus.PARTIAL]: translations.taskPartial,
    [TaskOutcomeStatus.BLOCKED]: translations.taskBlocked,
    [TaskOutcomeStatus.UNVERIFIED]: translations.taskUnverified,
  };

  return (
    <section className="workspace-page" aria-label={translations.assistant}>
      <Group justify="space-between" align="flex-start" className="page-heading">
        <Stack gap={8}>
          <Title order={1}>
            {user ? translations.welcome(firstName ?? user.name) : translations.workspaceHeading}
          </Title>
          <Text c="dimmed" size="sm">
            {translations.workspaceDescription}
          </Text>
        </Stack>
        {user && (
          <Button
            variant="default"
            leftSection={<IconPlus size={16} />}
            loading={isResetting}
            disabled={isSending || isSigningOut}
            onClick={() => void controller.startNewTask()}
          >
            {translations.newTask}
          </Button>
        )}
      </Group>

      {isLoading ? (
        <div className="workspace-empty" role="status">
          <Loader color="charcoal" size="sm" />
          <Text c="dimmed" size="sm">
            {translations.checkingSignIn}
          </Text>
        </div>
      ) : !user ? (
        <div className="workspace-empty">
          <div className="empty-symbol">
            <TroIcon size={58} />
          </div>
          <Title order={2}>{translations.makeYourselfAtHome}</Title>
          <Text c="dimmed" size="sm" maw={340} ta="center">
            {translations.googleInvitation}
          </Text>
          <Button
            leftSection={<IconBrandGoogle size={16} />}
            loading={isSigning}
            onClick={() => void controller.signInWithGoogle()}
          >
            {isSigning ? translations.waitingForGoogle : translations.continueWithGoogle}
          </Button>
        </div>
      ) : (
        <>
          {messages.length === 0 ? (
            <div className="workspace-empty">
              <div className="empty-symbol">
                <TroIcon size={58} />
              </div>
              <Title order={2}>{translations.helpHeading}</Title>
              <Text c="dimmed" size="sm" maw={360} ta="center">
                {translations.helpDescription}
              </Text>
            </div>
          ) : (
            <ol className="chat-messages" aria-label={translations.conversation} aria-live="polite">
              {messages.map((item, index) => (
                <Paper component="li" className="chat-message" data-role={item.role} key={index}>
                  <Text size="xs" fw={600} mb={8}>
                    {item.role === MessageRole.USER ? translations.you : 'Tro'}
                  </Text>
                  {item.outcome && (
                    <Text size="xs" c="dimmed" mb={8}>
                      {translations[TeachingOutcomeLabel[item.outcome]]}
                    </Text>
                  )}
                  <Text size="sm" className="message-text">
                    {item.text}
                  </Text>
                  {item.completion?.kind === CompletionMode.TASK && (
                    <Stack
                      gap={4}
                      mt="sm"
                      role="status"
                      data-outcome={item.completion.outcome.status}
                    >
                      <Text size="xs" fw={600}>
                        {outcomeLabels[item.completion.outcome.status]}
                      </Text>
                      {item.completion.outcome.limitation &&
                        item.completion.outcome.limitation !== item.text && (
                          <Text size="sm">{item.completion.outcome.limitation}</Text>
                        )}
                    </Stack>
                  )}
                </Paper>
              ))}
            </ol>
          )}
          {controller.teachingStep && (
            <Paper withBorder p="md" role="status" aria-live="polite">
              <Text size="xs" fw={600} mb={8}>
                Tro
              </Text>
              <Text size="sm" className="message-text">
                {controller.teachingStep}
              </Text>
            </Paper>
          )}
          <div className="composer-area">
            <Group justify="space-between" mb="sm">
              <SegmentedControl
                aria-label={translations.taskMode}
                value={controller.taskMode}
                disabled={isSending || isSigningOut || isResetting}
                data={[
                  { value: AgentTaskMode.TEACH, label: translations.showMe },
                  { value: AgentTaskMode.EXECUTE, label: translations.doIt },
                ]}
                onChange={(value) => {
                  controller.setTaskMode(AgentTaskModeSchema.parse(value));
                }}
              />
              {isSending && (
                <Button
                  variant="default"
                  loading={isResetting}
                  onClick={() => void controller.stopTask()}
                >
                  {controller.taskMode === AgentTaskMode.TEACH
                    ? translations.cancelLesson
                    : translations.stopTask}
                </Button>
              )}
            </Group>
            <Paper withBorder className="message-composer">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void controller.sendMessage();
                }}
              >
                <Textarea
                  aria-label={translations.yourMessage}
                  value={controller.messageInput}
                  onChange={(event) => {
                    controller.setMessageInput(event.currentTarget.value);
                  }}
                  placeholder={translations.messagePlaceholder}
                  autosize
                  minRows={2}
                  maxRows={6}
                  maxLength={8000}
                  disabled={
                    (isSending && !controller.canAnswerLesson) || isSigningOut || isResetting
                  }
                  required
                  variant="unstyled"
                />
                <Group justify="space-between" mt="sm" gap="sm">
                  <Text size="xs" c="dimmed" role="status">
                    {controller.teachingPhase === AgentProgressPhase.WAITING
                      ? translations.guidanceWaiting
                      : controller.teachingPhase === AgentProgressPhase.NEEDS_INPUT
                        ? translations.guidanceAwaitingAnswer
                        : controller.teachingPhase === AgentProgressPhase.PAUSED
                          ? translations.guidancePaused
                          : isSending
                            ? translations.working
                            : translations.freshStart}
                  </Text>
                  <Button
                    type="submit"
                    aria-label={translations.sendToTro}
                    className="send-button"
                    loading={isSending && !controller.canAnswerLesson}
                    disabled={isSigningOut || isResetting || !controller.messageInput.trim()}
                    rightSection={<IconArrowUp size={16} />}
                  >
                    {translations.send}
                  </Button>
                </Group>
              </form>
            </Paper>
            <Text size="xs" c="dimmed" className="task-disclosure">
              {controller.taskMode === AgentTaskMode.TEACH
                ? translations.teachingDisclosure
                : translations.taskDisclosure}
            </Text>
          </div>
        </>
      )}
    </section>
  );
}
