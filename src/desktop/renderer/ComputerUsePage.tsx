import { Button, Group, Loader, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconArrowUp, IconBrandGoogle, IconMessageCircle, IconPlus } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { useLocale } from './localization/UseLocale.js';
import { MessageRole, type ComputerUseController } from './UseComputerUse.js';

interface ComputerUsePageProps {
  controller: ComputerUseController;
}

/** The workspace uses the existing worker bridge; it never calls models directly. */
export function ComputerUsePage({ controller }: ComputerUsePageProps): ReactElement {
  const { messages: translations } = useLocale();
  const { user, isLoading, isSigning, isSending, isSigningOut, isResetting, messages } = controller;
  const firstName = user?.name.trim().split(/\s+/)[0];

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
            <IconMessageCircle size={28} stroke={1.5} />
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
                <IconMessageCircle size={28} stroke={1.5} />
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
                  <Text size="sm" className="message-text">
                    {item.text}
                  </Text>
                </Paper>
              ))}
            </ol>
          )}
          <div className="composer-area">
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
                  disabled={isSending || isSigningOut || isResetting}
                  required
                  variant="unstyled"
                />
                <Group justify="space-between" mt="sm" gap="sm">
                  <Text size="xs" c="dimmed" role="status">
                    {isSending ? translations.working : translations.freshStart}
                  </Text>
                  <Button
                    type="submit"
                    aria-label={translations.sendToTro}
                    className="send-button"
                    loading={isSending}
                    disabled={isSigningOut || isResetting || !controller.messageInput.trim()}
                    rightSection={<IconArrowUp size={16} />}
                  >
                    {translations.send}
                  </Button>
                </Group>
              </form>
            </Paper>
            <Text size="xs" c="dimmed" className="task-disclosure">
              {translations.taskDisclosure}
            </Text>
          </div>
        </>
      )}
    </section>
  );
}
