import { Button, Group, Loader, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconArrowUp, IconBrandGoogle, IconMessageCircle, IconPlus } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { MessageRole, type ComputerUseController } from './UseComputerUse.js';

interface ComputerUsePageProps {
  controller: ComputerUseController;
}

/** The workspace uses the existing worker bridge; it never calls models directly. */
export function ComputerUsePage({ controller }: ComputerUsePageProps): ReactElement {
  const { user, isLoading, isSigning, isSending, isSigningOut, isResetting, messages } = controller;
  const firstName = user?.name.trim().split(/\s+/)[0];

  return (
    <section className="workspace-page" aria-label="Computer-use assistant">
      <Group justify="space-between" align="flex-start" className="page-heading">
        <Stack gap={8}>
          <Title order={1}>
            {user ? `Welcome back, ${firstName ?? user.name}` : 'A little space to do more.'}
          </Title>
          <Text c="dimmed" size="sm">
            Your desktop, with a helping hand.
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
            New task
          </Button>
        )}
      </Group>

      {isLoading ? (
        <div className="workspace-empty" role="status">
          <Loader color="charcoal" size="sm" />
          <Text c="dimmed" size="sm">
            Checking sign-in…
          </Text>
        </div>
      ) : !user ? (
        <div className="workspace-empty">
          <div className="empty-symbol">
            <IconMessageCircle size={28} stroke={1.5} />
          </div>
          <Title order={2}>Make yourself at home.</Title>
          <Text c="dimmed" size="sm" maw={340} ta="center">
            Sign in to start a task with Tro. Google opens in your browser.
          </Text>
          <Button
            leftSection={<IconBrandGoogle size={16} />}
            loading={isSigning}
            onClick={() => void controller.signInWithGoogle()}
          >
            {isSigning ? 'Waiting for Google…' : 'Continue with Google'}
          </Button>
        </div>
      ) : (
        <>
          {messages.length === 0 ? (
            <div className="workspace-empty">
              <div className="empty-symbol">
                <IconMessageCircle size={28} stroke={1.5} />
              </div>
              <Title order={2}>What can I help you with?</Title>
              <Text c="dimmed" size="sm" maw={360} ta="center">
                Ask a question or tell Tro what you’d like to do in an app on your desktop.
              </Text>
            </div>
          ) : (
            <ol className="chat-messages" aria-label="Conversation" aria-live="polite">
              {messages.map((item, index) => (
                <Paper component="li" className="chat-message" data-role={item.role} key={index}>
                  <Text size="xs" fw={600} mb={8}>
                    {item.role === MessageRole.USER ? 'You' : 'Tro'}
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
                  aria-label="Your message"
                  value={controller.messageInput}
                  onChange={(event) => {
                    controller.setMessageInput(event.currentTarget.value);
                  }}
                  placeholder="Ask Tro to help with something…"
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
                    {isSending
                      ? 'Tro is working on your desktop…'
                      : 'A fresh start with every message'}
                  </Text>
                  <Button
                    type="submit"
                    aria-label="Send to Tro"
                    className="send-button"
                    loading={isSending}
                    disabled={isSigningOut || isResetting || !controller.messageInput.trim()}
                    rightSection={<IconArrowUp size={16} />}
                  >
                    Send
                  </Button>
                </Group>
              </form>
            </Paper>
            <Text size="xs" c="dimmed" className="task-disclosure">
              Tro may view your screen and use your mouse or keyboard. Screen observations sent to
              OpenAI leave your computer. Each message is a fresh task; this display clears when you
              close the app.
            </Text>
          </div>
        </>
      )}
    </section>
  );
}
