import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AccountRole } from '#contracts/AccountRole.js';
import type { SchoolClass } from '#contracts/Classroom.js';
import {
  GuidedLessonAction,
  GuidedLessonReadAction,
  type LessonPhase,
  type GuidedLessonCommand,
  type GuidedLessonDetail,
  type GuidedLessonReply,
  type GuidedLessonSummary,
  type LearnerProjection,
  type LessonPlan,
  type StudentLessonRequest,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';
import { useGuidedLessonBridge } from './UseGuidedLessonBridge.js';
import { GuidedLessonPreparation } from './GuidedLessonPreparation.js';
import { TeacherLessonStudio } from './TeacherLessonStudio.js';
import { StudentGuidedLesson } from './StudentGuidedLesson.js';
import { GuidedLessonRequests } from './GuidedLessonRequests.js';
import { isGuidedLessonRunning, readLessonStatusLabel } from './GuidedLessonLabels.js';
import './GuidedLessons.css';

type TeacherInput = Extract<GuidedLessonReply, { kind: 'teacherInput' }>;
type Playback = Extract<GuidedLessonReply, { kind: 'projection' }>;
const TeacherStudioAction = {
  APPROVE_SCRIPT: GuidedLessonAction.APPROVE_SCRIPT,
  RENDER: GuidedLessonAction.RENDER,
  APPROVE_PREVIEW: GuidedLessonAction.APPROVE_PREVIEW,
  RELEASE: GuidedLessonAction.RELEASE,
  WITHDRAW: GuidedLessonAction.WITHDRAW,
  CANCEL: GuidedLessonAction.CANCEL,
  RETRY: GuidedLessonAction.RETRY,
} as const;
type TeacherStudioAction = (typeof TeacherStudioAction)[keyof typeof TeacherStudioAction];

interface GuidedLessonsPageProps {
  userId: string;
  initialClassId: string | null;
  onChooseClass: (classId?: string) => void;
  onRoleChange: (role: AccountRole) => void;
}

/** An always-available navigation surface with teacher generation and enrolled home playback. */
export function GuidedLessonsPage({
  userId,
  initialClassId,
  onChooseClass,
  onRoleChange,
}: GuidedLessonsPageProps): ReactElement {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const [classId, setClassId] = useState<string | null>(initialClassId);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [lessons, setLessons] = useState<GuidedLessonSummary[]>([]);
  const [selected, setSelected] = useState<GuidedLessonSummary | null>(null);
  const [detail, setDetail] = useState<GuidedLessonDetail | null>(null);
  const [teacherInput, setTeacherInput] = useState<TeacherInput | null>(null);
  const [preview, setPreview] = useState<LearnerProjection | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [requests, setRequests] = useState<StudentLessonRequest[]>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestText, setRequestText] = useState('');
  const [requestConfirmed, setRequestConfirmed] = useState(false);
  const { read, command, error } = useGuidedLessonBridge(`${userId}:${classId ?? 'library'}`);
  const selectedClass = classes.find((item) => item.id === classId);
  const teacher = selectedClass?.teacherId === userId;

  const accept = useCallback((reply: GuidedLessonReply | null): void => {
    if (!reply || reply.kind === 'failed') {
      return;
    }
    if (reply.kind === 'list') {
      setClasses(reply.classes);
      setLessons(reply.lessons);
    }
    if (reply.kind === 'detail') {
      setDetail(reply.lesson);
      setSelected(reply.lesson);
    }
    if (reply.kind === 'teacherInput') {
      setTeacherInput(reply);
    }
    if (reply.kind === 'projection') {
      setPlayback(reply);
    }
    if (reply.kind === 'notes') {
      setPlayback((current) => (current ? { ...current, notes: reply.notes } : null));
    }
    if (reply.kind === 'requests') {
      setRequests(reply.requests);
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const reply = await read(
      classId
        ? { action: GuidedLessonReadAction.LIST, classId }
        : { action: GuidedLessonReadAction.LIST },
      'library',
    );
    accept(reply);
    if (reply?.kind === 'list' && !classId && reply.classes[0]) {
      setClassId(reply.classes[0].id);
      onChooseClass(reply.classes[0].id);
    }
    setLoading(false);
  }, [read, classId, accept, onChooseClass]);

  useEffect(() => {
    setClassId(initialClassId);
  }, [initialClassId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let current = true;
    void window.tro
      .controlClassroom?.({ kind: 'home' })
      .then((reply) => {
        if (current && reply.kind === 'home') {
          onRoleChange(reply.home.role);
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [userId, onRoleChange]);
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setPlayback(null);
    setPreview(null);
    setTeacherInput(null);
    setRequests([]);
    setCreating(false);
    setRequestOpen(false);
    if (classId && teacher) {
      void read({ action: GuidedLessonReadAction.REQUESTS, classId }, 'requests').then(accept);
    }
  }, [classId, teacher, read, accept]);
  useEffect(() => {
    if (!detail || !isGuidedLessonRunning(detail.status)) {
      return;
    }
    const timer = setInterval(() => {
      void read(
        { action: GuidedLessonReadAction.DETAIL, classId: detail.classId, lessonId: detail.id },
        'detail',
      ).then(accept);
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [detail?.id, detail?.status, read, accept]);

  const previewScene = useCallback(
    async (sceneId: string, phase?: LessonPhase): Promise<void> => {
      if (!detail) {
        return;
      }
      const reply = await read(
        {
          action: GuidedLessonReadAction.PREVIEW,
          classId: detail.classId,
          lessonId: detail.id,
          sceneId,
          ...(phase ? { phase } : {}),
        },
        'preview',
      );
      if (reply?.kind === 'projection') {
        setPreview(reply.projection);
      }
    },
    [detail, read],
  );
  useEffect(() => {
    if (
      detail?.manifest &&
      detail.plan?.scenes[0] &&
      (!preview || preview.contentHash !== detail.contentHash)
    ) {
      void previewScene(detail.plan.scenes[0].sceneId);
    }
  }, [detail?.manifest, detail?.contentHash, detail?.plan, preview, previewScene]);

  const send = useCallback(
    async (input: GuidedLessonCommand): Promise<GuidedLessonReply | null> => {
      if (busyRef.current) {
        return null;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const reply = await command(input);
        accept(reply);
        if (
          reply &&
          reply.kind !== 'failed' &&
          'releaseId' in input &&
          input.releaseId &&
          [
            GuidedLessonAction.HINT,
            GuidedLessonAction.HELP,
            GuidedLessonAction.SAVE_NOTE,
            GuidedLessonAction.DELETE_NOTE,
          ].some((action) => action === input.action)
        ) {
          accept(
            await read(
              {
                action: GuidedLessonReadAction.PROJECTION,
                classId: input.classId,
                releaseId: input.releaseId,
              },
              'projection',
            ),
          );
        }
        return reply;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [command, accept, read],
  );

  const openLesson = async (lesson: GuidedLessonSummary): Promise<void> => {
    setSelected(lesson);
    setCreating(false);
    setPreview(null);
    setPlayback(null);
    setDetail(null);
    if (teacher) {
      accept(
        await read(
          { action: GuidedLessonReadAction.DETAIL, classId: lesson.classId, lessonId: lesson.id },
          'detail',
        ),
      );
    } else if (lesson.releaseId) {
      accept(
        await read(
          {
            action: GuidedLessonReadAction.PROJECTION,
            classId: lesson.classId,
            releaseId: lesson.releaseId,
          },
          'projection',
        ),
      );
    }
  };
  const savePlan = async (plan: LessonPlan): Promise<void> => {
    if (!detail) {
      return;
    }
    await send({
      action: GuidedLessonAction.SAVE_PLAN,
      commandId: crypto.randomUUID(),
      classId: detail.classId,
      lessonId: detail.id,
      expectedVersion: detail.version,
      plan,
    });
  };
  const sendTeacher = async (
    action: TeacherStudioAction,
    evidenceIds: string[] = [],
  ): Promise<void> => {
    if (!detail) {
      return;
    }
    const base = {
      commandId: crypto.randomUUID(),
      classId: detail.classId,
      lessonId: detail.id,
      expectedVersion: detail.version,
    };
    if (action === GuidedLessonAction.APPROVE_SCRIPT) {
      if (detail.contentHash && detail.plan) {
        await send({
          action,
          ...base,
          contentHash: detail.contentHash,
          acknowledgedSceneIds: detail.plan.scenes.map((scene) => scene.sceneId),
        });
      }
    } else if (action === GuidedLessonAction.APPROVE_PREVIEW) {
      if (preview && detail.manifest) {
        await send({
          action,
          ...base,
          renderManifestHash: preview.renderManifestHash,
          acknowledgedEvidenceIds: evidenceIds,
        });
      }
    } else if (action === GuidedLessonAction.RELEASE) {
      if (detail.contentHash && preview) {
        await send({
          action,
          ...base,
          contentHash: detail.contentHash,
          renderManifestHash: preview.renderManifestHash,
        });
      }
    } else {
      await send({ action, ...base });
    }
  };

  return (
    <section className="guided-lessons-page">
      <header className="guided-page-heading">
        <div>
          <Text className="guided-eyebrow">TRO / {translate('Guided Lessons (Beta)')}</Text>
          <Title order={1}>
            {selected?.title ?? translate('One concept, explained step by step.')}
          </Title>
        </div>
        <Group>
          <Select
            aria-label={translate('Class')}
            placeholder={translate('Choose a class')}
            value={classId}
            data={classes.map((item) => ({ value: item.id, label: item.name }))}
            onChange={(value) => {
              setClassId(value);
              onChooseClass(value ?? undefined);
            }}
            disabled={busy}
          />
          <Button
            variant="outline"
            onClick={() => void (selected ? openLesson(selected) : refresh())}
            disabled={busy}
          >
            {translate('Refresh')}
          </Button>
        </Group>
      </header>
      {error && (
        <Alert role="alert" color="orange">
          {error}
        </Alert>
      )}
      {loading && (
        <Group role="status">
          <Loader size="sm" />
          <Text>{translate('Loading guided lessons…')}</Text>
        </Group>
      )}
      {!loading && classes.length === 0 && (
        <div className="guided-empty">
          <Text>{translate('No classes yet. Join or create a class in Classroom first.')}</Text>
        </div>
      )}
      {selected && (
        <Button
          variant="subtle"
          className="guided-back"
          onClick={() => {
            setSelected(null);
            setDetail(null);
            setPlayback(null);
            setPreview(null);
            void refresh();
          }}
        >
          {translate('Back to library')}
        </Button>
      )}
      {!selected && selectedClass && (
        <>
          <Group justify="space-between">
            <Text fw={600}>{translate(teacher ? 'Teacher studio' : 'Your lesson library')}</Text>
            {teacher ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setCreating(true);
                  void read(
                    { action: GuidedLessonReadAction.TEACHER_INPUT, classId: selectedClass.id },
                    'teacherInput',
                  ).then(accept);
                }}
              >
                {translate('Create a guided lesson')}
              </Button>
            ) : (
              <Button
                variant="light"
                onClick={() => {
                  setRequestOpen(true);
                }}
              >
                {translate('Request another explanation')}
              </Button>
            )}
          </Group>
          {creating && teacherInput && (
            <Card className="guided-preparation" withBorder>
              <Title order={2}>{translate('Create a guided lesson')}</Title>
              <Text size="sm" c="dimmed">
                {translate('Supported beta: integer running totals.')}
              </Text>
              <GuidedLessonPreparation
                input={teacherInput}
                busy={busy}
                onChooseRevision={(courseRevisionId) => {
                  void read(
                    {
                      action: GuidedLessonReadAction.TEACHER_INPUT,
                      classId: selectedClass.id,
                      courseRevisionId,
                    },
                    'teacherInput',
                  ).then(accept);
                }}
                onCreate={async (input) => {
                  const created = await send(input);
                  if (created?.kind === 'detail') {
                    setCreating(false);
                    await send({
                      action: GuidedLessonAction.START,
                      commandId: crypto.randomUUID(),
                      classId: created.lesson.classId,
                      lessonId: created.lesson.id,
                      expectedVersion: created.lesson.version,
                    });
                  }
                }}
              />
            </Card>
          )}
          <div className="guided-library-grid">
            {lessons
              .filter((lesson) => lesson.classId === classId && (teacher || lesson.releaseId))
              .map((lesson) => (
                <button
                  type="button"
                  key={lesson.id}
                  className="guided-library-card"
                  onClick={() => void openLesson(lesson)}
                >
                  <span className="guided-library-mark" aria-hidden="true">
                    ↗
                  </span>
                  <Badge variant="light">{translate(readLessonStatusLabel(lesson.status))}</Badge>
                  <h2>{lesson.title}</h2>
                  <p>{translate(teacher ? 'Review draft' : 'Open lesson')} →</p>
                </button>
              ))}
          </div>
          {!lessons.some((lesson) => lesson.classId === classId && (teacher || lesson.releaseId)) &&
            !creating && (
              <div className="guided-empty">
                <Text c="dimmed">
                  {translate(
                    teacher
                      ? 'No draft lessons yet. Choose approved material to begin.'
                      : 'No lessons have been released for this class yet.',
                  )}
                </Text>
              </div>
            )}
          {teacher && (
            <GuidedLessonRequests
              requests={requests}
              lessons={lessons}
              busy={busy}
              onResolve={async (requestId, resolution, lessonId, text) => {
                await send({
                  action: GuidedLessonAction.RESOLVE_REQUEST,
                  commandId: crypto.randomUUID(),
                  classId: selectedClass.id,
                  requestId,
                  resolution,
                  lessonId,
                  text,
                });
                accept(
                  await read(
                    { action: GuidedLessonReadAction.REQUESTS, classId: selectedClass.id },
                    'requests',
                  ),
                );
              }}
            />
          )}
        </>
      )}
      {teacher && detail && (
        <TeacherLessonStudio
          userId={userId}
          lesson={detail}
          preview={preview}
          busy={busy}
          onSavePlan={savePlan}
          onApproveScript={() => sendTeacher(GuidedLessonAction.APPROVE_SCRIPT)}
          onRender={() => sendTeacher(GuidedLessonAction.RENDER)}
          onApprovePreview={(evidenceIds) =>
            sendTeacher(GuidedLessonAction.APPROVE_PREVIEW, evidenceIds)
          }
          onRelease={() => sendTeacher(GuidedLessonAction.RELEASE)}
          onWithdraw={() => sendTeacher(GuidedLessonAction.WITHDRAW)}
          onCancel={() => sendTeacher(GuidedLessonAction.CANCEL)}
          onRetry={() => sendTeacher(GuidedLessonAction.RETRY)}
          onPreviewScene={previewScene}
        />
      )}
      {!teacher && selected && playback && (
        <StudentGuidedLesson
          key={`${selected.id}:${playback.projection.releaseId}`}
          userId={userId}
          lesson={selected}
          playback={playback}
          busy={busy}
          onCommand={send}
        />
      )}
      <Modal
        opened={requestOpen}
        onClose={() => {
          setRequestOpen(false);
        }}
        title={translate('Request another explanation')}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!classId || !requestConfirmed || !requestText.trim()) {
              return;
            }
            void send({
              action: GuidedLessonAction.REQUEST,
              commandId: crypto.randomUUID(),
              classId,
              lessonId: null,
              releaseId: null,
              sceneId: null,
              text: requestText.trim(),
            }).then((reply) => {
              if (reply && reply.kind !== 'failed') {
                setRequestOpen(false);
                setRequestText('');
                setRequestConfirmed(false);
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
              maxLength={2000}
              value={requestText}
              onChange={(event) => {
                setRequestText(event.currentTarget.value);
                setRequestConfirmed(false);
              }}
            />
            <Checkbox
              label={translate('I reviewed this request. My notes and chat are excluded.')}
              checked={requestConfirmed}
              onChange={(event) => {
                setRequestConfirmed(event.currentTarget.checked);
              }}
            />
            <Button type="submit" disabled={busy || !requestConfirmed || !requestText.trim()}>
              {translate('Send request')}
            </Button>
          </Stack>
        </form>
      </Modal>
    </section>
  );
}
