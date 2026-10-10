import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Radio,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  GuidedLessonAction,
  CheckpointKind,
  LearnerCheckpointState,
  LearnerProgressIntent,
  LessonPhase,
  LessonHelpRole,
  type GuidedLessonCommand,
  type GuidedLessonReply,
  type GuidedLessonSummary,
  type PrivateNote,
  type LessonHelpMessage,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';
import { GuidedLessonMedia } from './GuidedLessonMedia.js';
import { readLessonDurationFrames } from '../../../lessonMedia/LessonComposition.js';

type Playback = Extract<GuidedLessonReply, { kind: 'projection' }>;
const LessonPanel = { NONE: 'none', HELP: 'help', NOTES: 'notes', REQUEST: 'request' } as const;
type LessonPanel = (typeof LessonPanel)[keyof typeof LessonPanel];
interface HelpMessage extends LessonHelpMessage {
  step: string;
}

interface StudentGuidedLessonProps {
  userId: string;
  lesson: GuidedLessonSummary;
  playback: Playback;
  busy: boolean;
  onCommand: (command: GuidedLessonCommand) => Promise<GuidedLessonReply | null>;
}

/** The player consumes a safe projection; all attempts, hints and unlocks stay server-owned. */
export function StudentGuidedLesson({
  userId,
  lesson,
  playback,
  busy,
  onCommand,
}: StudentGuidedLessonProps): ReactElement {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const { projection, notes } = playback;
  const helpStep = `${projection.sceneId}:${projection.phase}`;
  const [frame, setFrame] = useState(projection.frame);
  const [seekFrame, setSeekFrame] = useState(projection.frame);
  const [panel, setPanel] = useState<LessonPanel>(LessonPanel.NONE);
  const [answer, setAnswer] = useState('');
  const [question, setQuestion] = useState('');
  const [helpText, setHelpText] = useState('');
  const [helpHistory, setHelpHistory] = useState<HelpMessage[]>([]);
  const currentHelpHistory = helpHistory.filter((message) => message.step === helpStep);
  const [noteText, setNoteText] = useState('');
  const [requestText, setRequestText] = useState('');
  const [requestConfirmed, setRequestConfirmed] = useState(false);
  const [reflection, setReflection] = useState('');
  const [mediaReady, setMediaReady] = useState(false);
  const receiveFrame = useCallback((value: number): void => {
    setFrame(value);
  }, []);
  const receiveReady = useCallback((value: boolean): void => {
    setMediaReady(value);
  }, []);
  const reachedEnd = frame >= readLessonDurationFrames(projection) - 2;
  const checkpoint = projection.checkpoint;
  const pending =
    checkpoint?.state === LearnerCheckpointState.PENDING ||
    checkpoint?.state === LearnerCheckpointState.ATTEMPTED;
  const base = {
    classId: lesson.classId,
    lessonId: lesson.id,
    releaseId: projection.releaseId,
    expectedProgressVersion: projection.progressVersion,
  };
  const phaseLabels = {
    [LessonPhase.WATCH]: 'Watch',
    [LessonPhase.PREDICT]: 'Predict',
    [LessonPhase.WORKED]: 'Worked answer',
    [LessonPhase.TRY]: 'Try',
    [LessonPhase.REFLECT]: 'Reflect',
  };

  useEffect(() => {
    setFrame(projection.frame);
    setSeekFrame(projection.frame);
    setAnswer('');
    setHelpText('');
    setHelpHistory([]);
    setQuestion('');
  }, [projection.sceneId, projection.phase]);

  const sendProgress = async (
    intent: LearnerProgressIntent,
    sceneId = projection.sceneId,
    requestedFrame = frame,
  ): Promise<boolean> => {
    const reply = await onCommand({
      action: GuidedLessonAction.PROGRESS,
      commandId: crypto.randomUUID(),
      ...base,
      sceneId,
      intent,
      frame: requestedFrame,
      reflection: intent === LearnerProgressIntent.REFLECT ? reflection : '',
    });
    return Boolean(reply && reply.kind !== 'failed');
  };
  const acceptHelp = (reply: GuidedLessonReply | null): void => {
    if (reply?.kind === 'help' && reply.result.kind !== 'hintSelection') {
      setHelpText(reply.result.text);
    }
    if (reply?.kind === 'hint') {
      setHelpText(reply.text);
    }
  };
  const askQuestion = async (): Promise<void> => {
    const message = question.trim();
    if (!message || busy) {
      return;
    }
    const history = currentHelpHistory
      .slice(-12)
      .map((item) => ({ role: item.role, text: item.text.slice(0, 2500) }));
    const studentMessage: HelpMessage = {
      step: helpStep,
      role: LessonHelpRole.USER,
      text: message,
    };
    setHelpHistory((current) => [...current, studentMessage].slice(-12));
    const reply = await onCommand({
      action: GuidedLessonAction.HELP,
      commandId: crypto.randomUUID(),
      ...base,
      sceneId: projection.sceneId,
      message,
      history,
    });
    if (reply?.kind === 'help' && reply.result.kind !== 'hintSelection') {
      const assistantMessage: HelpMessage = {
        step: helpStep,
        role: LessonHelpRole.ASSISTANT,
        text: reply.result.text,
      };
      setHelpHistory((current) => [...current, assistantMessage].slice(-12));
      setQuestion('');
    }
  };
  const returnToNote = async (note: PrivateNote): Promise<void> => {
    const reply = await onCommand({
      action: GuidedLessonAction.PROGRESS,
      commandId: crypto.randomUUID(),
      ...base,
      sceneId: note.anchor.sceneId,
      intent: LearnerProgressIntent.REVISIT,
      frame: note.anchor.frame,
      reflection: '',
      noteId: note.noteId,
    });
    if (
      reply?.kind === 'projection' &&
      reply.projection.sceneId === note.anchor.sceneId &&
      reply.projection.phase === note.anchor.phase
    ) {
      setSeekFrame(reply.projection.frame);
      setFrame(reply.projection.frame);
      setPanel(LessonPanel.NONE);
    }
  };
  const saveNote = async (): Promise<void> => {
    if (!noteText.trim()) {
      return;
    }
    const note: PrivateNote = {
      noteId: crypto.randomUUID(),
      expectedVersion: 0,
      anchor: {
        releaseId: projection.releaseId,
        sceneId: projection.sceneId,
        phase: projection.phase,
        frame,
        traceEventId:
          projection.visualCues.find((cue) => frame >= cue.startFrame && frame < cue.endFrame)
            ?.eventId ?? null,
        sourceRef: null,
      },
      text: noteText.trim(),
      isBookmark: false,
    };
    const reply = await onCommand({
      action: GuidedLessonAction.SAVE_NOTE,
      commandId: crypto.randomUUID(),
      ...base,
      note,
    });
    if (reply && reply.kind !== 'failed') {
      setNoteText('');
    }
  };

  return (
    <div className="guided-learning-layout">
      <aside className="guided-lesson-rail" aria-label={translate('Lesson phases')}>
        <Text size="xs" tt="uppercase" c="dimmed">
          {translate('One concept, explained step by step.')}
        </Text>
        <ol className="guided-phase-list">
          {Object.values(LessonPhase).map((phase, index) => (
            <li key={phase} aria-current={projection.phase === phase ? 'step' : undefined}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{translate(phaseLabels[phase])}</strong>
            </li>
          ))}
        </ol>
        <Button
          variant="subtle"
          onClick={() => {
            setPanel(LessonPanel.HELP);
          }}
        >
          {translate('Ask about this step')}
        </Button>
        <Button
          variant="subtle"
          onClick={() => {
            setPanel(LessonPanel.NOTES);
          }}
        >
          {translate('Private notebook')}
        </Button>
        <Button
          variant="subtle"
          onClick={() => {
            setPanel(LessonPanel.REQUEST);
          }}
        >
          {translate('Request another explanation')}
        </Button>
      </aside>
      <Stack gap="md" className="guided-workbench">
        <Group justify="space-between">
          <Text fw={600}>{projection.sceneTitle}</Text>
          <Badge variant="light">{translate(phaseLabels[projection.phase])}</Badge>
        </Group>
        <GuidedLessonMedia
          userId={userId}
          classId={lesson.classId}
          lessonId={lesson.id}
          releaseId={projection.releaseId}
          projection={projection}
          paused={panel !== LessonPanel.NONE || busy}
          initialFrame={seekFrame}
          onFrameChange={receiveFrame}
          onReadyChange={receiveReady}
        />
        {checkpoint && (
          <section className="guided-prediction">
            <Group justify="space-between">
              <Text fw={600}>{checkpoint.question}</Text>
              {checkpoint.state === LearnerCheckpointState.INDEPENDENT && (
                <Badge color="green">{translate('Completed independently')}</Badge>
              )}
              {checkpoint.state === LearnerCheckpointState.ASSISTED && (
                <Badge color="yellow">{translate('Completed with support')}</Badge>
              )}
            </Group>
            {pending && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!answer.trim() || busy) {
                    return;
                  }
                  const value = Number(answer);
                  if (
                    checkpoint.kind === CheckpointKind.NUMERIC_TRACE &&
                    (!Number.isInteger(value) || Math.abs(value) > 1_000_000)
                  ) {
                    return;
                  }
                  void onCommand({
                    action: GuidedLessonAction.ATTEMPT,
                    commandId: crypto.randomUUID(),
                    ...base,
                    checkpointId: checkpoint.checkpointId,
                    answer:
                      checkpoint.kind === CheckpointKind.NUMERIC_TRACE
                        ? { kind: 'number', value }
                        : { kind: 'option', optionId: answer },
                  });
                }}
              >
                <Stack gap="sm">
                  <Text size="sm" c="dimmed">
                    {translate('Pause to make your prediction.')}
                  </Text>
                  {checkpoint.kind === CheckpointKind.NUMERIC_TRACE ? (
                    <TextInput
                      label={translate('Your prediction')}
                      value={answer}
                      inputMode="numeric"
                      onChange={(event) => {
                        setAnswer(event.currentTarget.value);
                      }}
                      disabled={busy}
                    />
                  ) : (
                    <Radio.Group
                      label={translate('Your prediction')}
                      value={answer}
                      onChange={setAnswer}
                    >
                      <Stack gap="xs">
                        {checkpoint.options.map((option) => (
                          <Radio
                            key={option.optionId}
                            value={option.optionId}
                            label={option.text}
                            disabled={busy}
                          />
                        ))}
                      </Stack>
                    </Radio.Group>
                  )}
                  <Group>
                    <Button type="submit" disabled={!answer.trim() || busy}>
                      {translate('Check answer')}
                    </Button>
                    <Button
                      variant="light"
                      disabled={busy || checkpoint.availableHintCount === 0}
                      onClick={() => {
                        void onCommand({
                          action: GuidedLessonAction.HINT,
                          commandId: crypto.randomUUID(),
                          ...base,
                          checkpointId: checkpoint.checkpointId,
                        }).then(acceptHelp);
                      }}
                    >
                      {translate('Next hint')}
                    </Button>
                    <Button
                      variant="subtle"
                      disabled={busy}
                      onClick={() => void sendProgress(LearnerProgressIntent.WORKED_ANSWER)}
                    >
                      {translate('Show worked answer')}
                    </Button>
                  </Group>
                  {checkpoint.state === LearnerCheckpointState.ATTEMPTED && (
                    <Text size="sm" c="dimmed">
                      {translate('Try again or choose a hint.')}
                    </Text>
                  )}
                </Stack>
              </form>
            )}
            {!pending && (
              <Button
                variant="subtle"
                disabled={busy}
                onClick={() => void sendProgress(LearnerProgressIntent.RETRY)}
              >
                {translate('Try this checkpoint again')}
              </Button>
            )}
            {helpText && <Alert color="green">{helpText}</Alert>}
            <Text size="xs" c="dimmed">
              {translate('This is practice, not a graded examination.')}
            </Text>
          </section>
        )}
        {projection.phase === LessonPhase.REFLECT ? (
          <Stack>
            <Textarea
              label={playback.reflectionPrompt}
              value={reflection}
              maxLength={2000}
              onChange={(event) => {
                setReflection(event.currentTarget.value);
              }}
            />
            <Button
              disabled={busy}
              onClick={() => void sendProgress(LearnerProgressIntent.REFLECT)}
            >
              {translate('Save private reflection')}
            </Button>
          </Stack>
        ) : (
          !pending && (
            <Group justify="flex-end">
              {!reachedEnd && (
                <Text size="xs" c="dimmed">
                  {translate('Watch this step to the end to continue.')}
                </Text>
              )}
              <Button
                disabled={busy || !mediaReady || !reachedEnd}
                onClick={() =>
                  void sendProgress(
                    projection.phase === LessonPhase.WATCH
                      ? LearnerProgressIntent.WATCH_COMPLETE
                      : LearnerProgressIntent.NEXT,
                  )
                }
              >
                {translate('Continue')}
              </Button>
            </Group>
          )
        )}
      </Stack>
      <Modal
        opened={panel === LessonPanel.HELP}
        onClose={() => {
          setPanel(LessonPanel.NONE);
        }}
        title={translate('Ask about this step')}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!question.trim()) {
              return;
            }
            void askQuestion();
          }}
        >
          <Stack>
            <Text size="sm" c="dimmed">
              {translate('Playback pauses while you ask.')}
            </Text>
            <Text size="xs" c="dimmed">
              {translate('The latest six exchanges for this step stay here.')}
            </Text>
            <Stack gap="xs" aria-live="polite">
              {currentHelpHistory.map((message, index) => (
                <div key={`${String(index)}:${message.role}`} className="guided-help-message">
                  <Text size="xs" fw={600}>
                    {translate(message.role === LessonHelpRole.USER ? 'You' : 'Lesson assistant')}
                  </Text>
                  <Text size="sm">{message.text}</Text>
                </div>
              ))}
            </Stack>
            <Textarea
              label={translate('Your question')}
              value={question}
              maxLength={2000}
              onChange={(event) => {
                setQuestion(event.currentTarget.value);
              }}
            />
            <Group>
              <Button type="submit" disabled={!question.trim() || busy}>
                {translate('Ask')}
              </Button>
              <Button
                variant="subtle"
                disabled={busy || !currentHelpHistory.length}
                onClick={() => {
                  setHelpHistory([]);
                  setHelpText('');
                }}
              >
                {translate('Clear conversation')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
      <Modal
        opened={panel === LessonPanel.NOTES}
        onClose={() => {
          setPanel(LessonPanel.NONE);
        }}
        title={translate('Private notebook')}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {translate(
              'Only you can see these notes. They are not included in requests or generation.',
            )}
          </Text>
          <Textarea
            label={translate('Note at this step')}
            value={noteText}
            maxLength={2000}
            onChange={(event) => {
              setNoteText(event.currentTarget.value);
            }}
          />
          <Button disabled={busy || !noteText.trim()} onClick={() => void saveNote()}>
            {translate('Save private note')}
          </Button>
          <Text fw={600}>{translate('Saved notes')}</Text>
          {notes.map((note) => (
            <div key={note.noteId} className="guided-note">
              <Text size="sm">{note.text}</Text>
              <Group>
                <Button
                  variant="subtle"
                  size="compact-xs"
                  disabled={busy}
                  onClick={() => {
                    void returnToNote(note);
                  }}
                >
                  {translate('Return to this note')}
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  size="compact-xs"
                  disabled={busy}
                  onClick={() =>
                    void onCommand({
                      action: GuidedLessonAction.DELETE_NOTE,
                      commandId: crypto.randomUUID(),
                      ...base,
                      noteId: note.noteId,
                      expectedNoteVersion: note.expectedVersion,
                    })
                  }
                >
                  {translate('Delete note')}
                </Button>
              </Group>
            </div>
          ))}
        </Stack>
      </Modal>
      <Modal
        opened={panel === LessonPanel.REQUEST}
        onClose={() => {
          setPanel(LessonPanel.NONE);
        }}
        title={translate('Request another explanation')}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!requestConfirmed || !requestText.trim()) {
              return;
            }
            void onCommand({
              action: GuidedLessonAction.REQUEST,
              commandId: crypto.randomUUID(),
              classId: lesson.classId,
              lessonId: lesson.id,
              releaseId: projection.releaseId,
              sceneId: projection.sceneId,
              text: requestText.trim(),
            }).then((reply) => {
              if (reply && reply.kind !== 'failed') {
                setRequestText('');
                setRequestConfirmed(false);
                setPanel(LessonPanel.NONE);
              }
            });
          }}
        >
          <Stack>
            <Text size="sm">
              {translate('Your teacher will see this text and the selected lesson reference.')}
            </Text>
            <Textarea
              label={translate('What would you like explained?')}
              value={requestText}
              maxLength={2000}
              onChange={(event) => {
                setRequestText(event.currentTarget.value);
                setRequestConfirmed(false);
              }}
            />
            <Checkbox
              checked={requestConfirmed}
              onChange={(event) => {
                setRequestConfirmed(event.currentTarget.checked);
              }}
              label={translate('I reviewed this request. My notes and chat are excluded.')}
            />
            <Button type="submit" disabled={!requestConfirmed || !requestText.trim() || busy}>
              {translate('Send request')}
            </Button>
          </Stack>
        </form>
      </Modal>
    </div>
  );
}
