import type { ReactElement } from 'react';
import {
  TraceOperation,
  LessonTemplateKind,
  CheckpointPhase,
  type Checkpoint,
  type LessonInput,
  type Scene,
  type StateValue,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';

interface LessonStoryboardProps {
  scene: Scene;
  input: LessonInput | null;
  checkpoint: Checkpoint | undefined;
  compact?: boolean;
}

function formatStateValue(value: StateValue | undefined): string {
  return value === undefined ? '—' : Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/** A script illustration reads canonical states; it never runs code or stands in for rendered media. */
export function LessonStoryboard({
  scene,
  input,
  checkpoint,
  compact = false,
}: LessonStoryboardProps): ReactElement {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const traceId =
    scene.kind === LessonTemplateKind.CODE_TRACE || scene.kind === LessonTemplateKind.CHECKPOINT
      ? scene.params.traceId
      : null;
  const trace = input?.traces.find((item) => item.traceId === traceId);
  const code = input?.codeBlocks.find((item) => item.codeBlockId === trace?.codeBlockId);
  const events =
    scene.kind === LessonTemplateKind.CODE_TRACE
      ? (trace?.events.filter((event) => scene.params.traceEventIds.includes(event.eventId)) ?? [])
      : [];
  const additions = events.filter((event) => event.operation === TraceOperation.ADD);
  const shownEvents = (additions.length ? additions : events).slice(0, 3);
  const focusVariable =
    scene.kind === LessonTemplateKind.CODE_TRACE ? scene.params.focusVariable : '';
  const finalEvent = events.at(-1);
  const finalValue = finalEvent?.after.find((binding) => binding.name === focusVariable)?.value;
  const sourceRef = scene.sourceRefs[0];
  const passage = input?.passages.find((item) => item.passageId === sourceRef?.passageId);
  const sourceText =
    sourceRef && passage ? passage.text.slice(sourceRef.startOffset, sourceRef.endOffset) : '';

  if (compact) {
    return (
      <div className={`studio-thumbnail-art studio-thumbnail-${scene.kind}`} aria-hidden="true">
        {scene.kind === LessonTemplateKind.CHECKPOINT ? (
          <>
            <span className="studio-thumbnail-question">?</span>
            <span>{translate('Question')}</span>
          </>
        ) : scene.kind === LessonTemplateKind.CODE_TRACE ? (
          <>
            <span className="studio-thumbnail-value">{formatStateValue(finalValue)}</span>
            <code>{focusVariable}</code>
            <div className="studio-thumbnail-states">
              {shownEvents.map((event) => (
                <span key={event.eventId}>
                  {formatStateValue(
                    event.after.find((binding) => binding.name === focusVariable)?.value,
                  )}
                </span>
              ))}
            </div>
          </>
        ) : scene.kind === LessonTemplateKind.SOURCE_EXPLANATION ? (
          <>
            <span className="studio-thumbnail-quote">“</span>
            <span className="studio-thumbnail-source">{scene.params.points[0]?.text}</span>
          </>
        ) : (
          <>
            <span className="studio-thumbnail-quote">“</span>
            <span className="studio-thumbnail-source">
              {scene.params.callouts[0]?.label ?? translate('Sources')}
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <article className={`studio-storyboard studio-storyboard-${scene.kind}`}>
      <div className="studio-storyboard-top">
        <span>{translate('Script illustration')}</span>
        <span>
          {translate(
            scene.kind === LessonTemplateKind.CHECKPOINT
              ? 'Question'
              : scene.kind === LessonTemplateKind.CODE_TRACE
                ? 'Python'
                : 'Sources',
          )}
        </span>
      </div>
      <h3>
        {scene.kind === LessonTemplateKind.CHECKPOINT && checkpoint
          ? checkpoint.question
          : scene.title}
      </h3>
      {scene.kind === LessonTemplateKind.CODE_TRACE && (
        <div className="studio-trace-layout">
          <div className="studio-trace-feature">
            <code>{focusVariable}</code>
            <strong>{formatStateValue(finalValue)}</strong>
            <span>{translate('Last state in this scene')}</span>
          </div>
          <div className="studio-trace-content">
            {shownEvents.length > 0 && (
              <div className="studio-state-chain">
                {shownEvents.map((event, index) => (
                  <div className="studio-state-step" key={event.eventId}>
                    <span>
                      {translate('Step')} {index + 1}
                    </span>
                    <div>
                      <strong>
                        {formatStateValue(
                          event.before.find((binding) => binding.name === focusVariable)?.value,
                        )}
                      </strong>
                      <span aria-label={translate('After')}>→</span>
                      <strong>
                        {formatStateValue(
                          event.after.find((binding) => binding.name === focusVariable)?.value,
                        )}
                      </strong>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {code && (
              <pre className="studio-storyboard-code">
                {code.lines.map((line) => line.text).join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
      {scene.kind === LessonTemplateKind.CHECKPOINT && checkpoint && (
        <div className="studio-question-layout">
          <span className="studio-question-mark" aria-hidden="true">
            ?
          </span>
          <div>
            {checkpoint.options.length > 0 ? (
              <ol>
                {checkpoint.options.map((option) => (
                  <li key={option.optionId}>{option.text}</li>
                ))}
              </ol>
            ) : (
              <p>{translate('Let students predict before showing the worked answer.')}</p>
            )}
            <span className="studio-question-phase">
              {translate(checkpoint.phase === CheckpointPhase.TRY ? 'Try' : 'Predict')}
            </span>
          </div>
        </div>
      )}
      {scene.kind === LessonTemplateKind.ANNOTATED_SOURCE && (
        <div className="studio-source-layout">
          <blockquote>{sourceText}</blockquote>
          <ol>
            {scene.params.callouts.map((callout) => (
              <li key={callout.calloutId}>{callout.label}</li>
            ))}
          </ol>
        </div>
      )}
      {scene.kind === LessonTemplateKind.SOURCE_EXPLANATION && (
        <ol className="studio-explanation-points">
          {scene.params.points.map((point, index) => (
            <li key={point.pointId}>
              <span aria-hidden="true">{index + 1}</span>
              <p>{point.text}</p>
            </li>
          ))}
        </ol>
      )}
      <p className="studio-storyboard-caption">
        {translate('Based on the script and approved sources. This is not a rendered video.')}
      </p>
    </article>
  );
}
