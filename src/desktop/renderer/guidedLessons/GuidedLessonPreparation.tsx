import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import {
  GuidedLessonAction,
  LessonLanguage,
  SourcePassageKind,
  type GuidedLessonCommand,
  type GuidedLessonReply,
  type SourcePassage,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';
import './GuidedLessonPreparation.css';

type TeacherInput = Extract<GuidedLessonReply, { kind: 'teacherInput' }>;
type CreateLesson = Extract<GuidedLessonCommand, { action: 'create' }>;

const PreparationStep = {
  CONTENT: 'content',
  REVIEW: 'review',
} as const;
type PreparationStep = (typeof PreparationStep)[keyof typeof PreparationStep];

interface GuidedLessonPreparationProps {
  input: TeacherInput;
  busy: boolean;
  onChooseRevision: (revisionId: string) => void;
  onCreate: (command: CreateLesson) => Promise<void>;
}

/** Match the input builder's inclusion of published corrections for each chosen source. */
function readIncludedPassages(
  passages: readonly SourcePassage[],
  chosenPassageIds: readonly string[],
): SourcePassage[] {
  return passages.filter(
    (passage) =>
      chosenPassageIds.includes(passage.passageId) ||
      passage.correctsPassageIds.some((passageId) => chosenPassageIds.includes(passageId)),
  );
}

/** Prepares a source explanation from the selected approved material and its exact passages. */
export function GuidedLessonPreparation({
  input,
  busy,
  onChooseRevision,
  onCreate,
}: GuidedLessonPreparationProps): ReactElement {
  const { messages, locale } = useLocale();
  const translate = messages.translateGuidedLesson;
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<PreparationStep>(PreparationStep.CONTENT);
  const [revisionId, setRevisionId] = useState(input.revisions[0]?.id ?? '');
  const [sectionId, setSectionId] = useState('');
  const [chosenPassageIds, setChosenPassageIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [objective, setObjective] = useState('');
  const [audience, setAudience] = useState('');
  const [language, setLanguage] = useState<LessonLanguage>(locale);
  const [duration, setDuration] = useState('180');
  const [instructions, setInstructions] = useState('');
  const revision = input.revisions.find((item) => item.id === revisionId);
  const section = revision?.sections.find((item) => item.id === sectionId);
  const sectionPassages = readIncludedPassages(input.passages, section?.passageIds ?? []);
  const selectedPassages = readIncludedPassages(input.passages, chosenPassageIds);
  const matchingPassages = sectionPassages.filter((passage) =>
    passage.text.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)),
  );
  useEffect(() => {
    if (!input.revisions.some((item) => item.id === revisionId)) {
      setRevisionId(input.revisions[0]?.id ?? '');
      setSectionId('');
      setChosenPassageIds([]);
      setStep(PreparationStep.CONTENT);
    }
  }, [input, revisionId]);

  const canContinueContent = Boolean(
    revision &&
    section &&
    objective.trim() &&
    objective.length <= 500 &&
    audience.trim() &&
    audience.length <= 400 &&
    instructions.length <= 2000 &&
    selectedPassages.length > 0 &&
    selectedPassages.length <= 8 &&
    chosenPassageIds.every((passageId) =>
      sectionPassages.some((passage) => passage.passageId === passageId),
    ),
  );
  const canSubmit = canContinueContent && !busy;
  const durationLabel = translate(
    duration === '60' ? '1 minute' : duration === '180' ? '3 minutes' : '5 minutes',
  );
  const languageLabel = translate(language === LessonLanguage.EN ? 'English' : 'Vietnamese');
  const steps = [
    { value: PreparationStep.CONTENT, label: translate('Content') },
    { value: PreparationStep.REVIEW, label: translate('Review') },
  ];

  function chooseStep(next: PreparationStep): void {
    if (busy || (next === PreparationStep.REVIEW && !canContinueContent)) {
      return;
    }
    setStep(next);
    /* Focus follows the newly mounted heading, without forcing the page to scroll. */
    window.requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  function advanceStep(form: HTMLFormElement): void {
    if (!form.reportValidity()) {
      return;
    }
    chooseStep(PreparationStep.REVIEW);
  }

  function renderInstructions(): ReactElement {
    return (
      <details className="preparation-instructions">
        <summary>
          {translate('Teacher instructions')} <span>{translate('Optional')}</span>
        </summary>
        <div className="preparation-field">
          <label className="preparation-screen-reader" htmlFor={`${id}-instructions`}>
            {translate('Teacher instructions')}
          </label>
          <textarea
            id={`${id}-instructions`}
            value={instructions}
            onChange={(event) => {
              setInstructions(event.currentTarget.value);
            }}
            maxLength={2000}
            rows={3}
            placeholder={translate('Optional guidance for this explanation')}
          />
        </div>
      </details>
    );
  }

  function renderPassage(passage: SourcePassage, index: number, selectable: boolean): ReactElement {
    const correction = passage.kind !== SourcePassageKind.SOURCE_TEXT;
    const label = `${translate(correction ? 'Correction' : 'Passage')} ${String(index + 1)}`;
    const excerpt = passage.text.replace(/\s+/g, ' ');
    const selected = selectedPassages.some((item) => item.passageId === passage.passageId);
    const requiredWithSource = passage.correctsPassageIds.some((passageId) =>
      chosenPassageIds.includes(passageId),
    );
    const exceedsLimit =
      !selected &&
      readIncludedPassages(input.passages, [...chosenPassageIds, passage.passageId]).length > 8;
    return (
      <article
        className={`preparation-source ${correction ? 'preparation-correction' : ''}`}
        key={passage.passageId}
      >
        <div className="preparation-source-heading">
          {selectable ? (
            <>
              <input
                id={`${id}-source-${passage.passageId}`}
                type="checkbox"
                checked={selected}
                aria-describedby={[
                  `${id}-excerpt-${passage.passageId}`,
                  ...(requiredWithSource ? [`${id}-required-${passage.passageId}`] : []),
                ].join(' ')}
                disabled={busy || requiredWithSource || exceedsLimit}
                onChange={(event) => {
                  if (requiredWithSource) {
                    return;
                  }
                  const checked = event.currentTarget.checked;
                  setChosenPassageIds((current) => {
                    const next = checked
                      ? [...current, passage.passageId]
                      : current.filter((value) => value !== passage.passageId);
                    return readIncludedPassages(input.passages, next).length <= 8 ? next : current;
                  });
                }}
              />
              <label htmlFor={`${id}-source-${passage.passageId}`}>{label}</label>
            </>
          ) : (
            <strong>{label}</strong>
          )}
        </div>
        {requiredWithSource && (
          <p
            id={`${id}-required-${passage.passageId}`}
            className="preparation-help preparation-required"
          >
            {translate('Required with selected source')}
          </p>
        )}
        <p id={`${id}-excerpt-${passage.passageId}`} className="preparation-source-excerpt">
          {excerpt.length > 120 ? `${excerpt.slice(0, 120)}…` : excerpt}
        </p>
        <details className="preparation-source-text">
          <summary aria-label={`${translate('Read exact text')}: ${label}`}>
            {translate('Read')}
          </summary>
          <dl className="preparation-source-metadata">
            <div>
              <dt>{translate('Approved source')}</dt>
              <dd>{revision?.title}</dd>
            </div>
          </dl>
          <p>{passage.text}</p>
        </details>
      </article>
    );
  }

  return (
    <form
      className="guided-preparation-form"
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          step !== PreparationStep.REVIEW &&
          event.target instanceof HTMLInputElement &&
          event.target.type !== 'checkbox'
        ) {
          event.preventDefault();
          advanceStep(event.currentTarget);
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (step !== PreparationStep.REVIEW) {
          advanceStep(event.currentTarget);
          return;
        }
        if (!canSubmit || !event.currentTarget.reportValidity()) {
          return;
        }
        void onCreate({
          action: GuidedLessonAction.CREATE,
          commandId: crypto.randomUUID(),
          classId: input.classId,
          courseRevisionId: revisionId,
          conceptId: sectionId,
          objective: objective.trim(),
          audience: audience.trim(),
          language,
          targetDurationSeconds: Number(duration),
          passageIds: selectedPassages.map((passage) => passage.passageId),
          teacherInstructions: instructions.trim(),
          codeApproval: null,
          practiceCodeApproval: null,
        });
      }}
    >
      <nav className="preparation-steps" aria-label={translate('Lesson preparation')}>
        {steps.map((item, index) => (
          <button
            key={item.value}
            type="button"
            aria-current={step === item.value ? 'step' : undefined}
            disabled={busy || (item.value === PreparationStep.REVIEW && !canContinueContent)}
            onClick={() => {
              chooseStep(item.value);
            }}
          >
            <span aria-hidden="true">{index + 1}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <h2 ref={heading} className="preparation-screen-reader" tabIndex={-1}>
        {steps.find((item) => item.value === step)?.label}
      </h2>
      <fieldset disabled={busy} className="preparation-body">
        {step === PreparationStep.CONTENT && (
          <>
            <div className="preparation-fields">
              <div className="preparation-field">
                <label htmlFor={`${id}-revision`}>{translate('Approved source')}</label>
                <select
                  id={`${id}-revision`}
                  value={revisionId}
                  required
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setRevisionId(value);
                    setSectionId('');
                    setChosenPassageIds([]);
                    setQuery('');
                    if (value) {
                      onChooseRevision(value);
                    }
                  }}
                >
                  <option value="">{translate('Choose approved material')}</option>
                  {input.revisions.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="preparation-field">
                <label htmlFor={`${id}-section`}>{translate('Concept or section')}</label>
                <select
                  id={`${id}-section`}
                  value={sectionId}
                  required
                  disabled={!revision}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    const chosen = revision?.sections.find((item) => item.id === value);
                    const available = readIncludedPassages(
                      input.passages,
                      chosen?.passageIds ?? [],
                    );
                    setSectionId(value);
                    setChosenPassageIds(
                      available.length <= 8 ? available.map((passage) => passage.passageId) : [],
                    );
                    setQuery('');
                  }}
                >
                  <option value="">{translate('Choose a section')}</option>
                  {revision?.sections.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="preparation-field preparation-wide">
                <label htmlFor={`${id}-objective`}>{translate('Learning objective')}</label>
                <input
                  id={`${id}-objective`}
                  value={objective}
                  onChange={(event) => {
                    setObjective(event.currentTarget.value);
                  }}
                  maxLength={500}
                  required
                  placeholder={translate('What should students understand after this explanation?')}
                />
              </div>
              <div className="preparation-field preparation-wide">
                <label htmlFor={`${id}-audience`}>{translate('Audience')}</label>
                <input
                  id={`${id}-audience`}
                  value={audience}
                  onChange={(event) => {
                    setAudience(event.currentTarget.value);
                  }}
                  maxLength={400}
                  required
                />
              </div>
            </div>
            <details className="preparation-options">
              <summary>
                <strong>{translate('Options')}</strong>
                <span>
                  {durationLabel} · {languageLabel}
                </span>
              </summary>
              <div className="preparation-fields">
                <div className="preparation-field">
                  <label htmlFor={`${id}-language`}>{translate('Language')}</label>
                  <select
                    id={`${id}-language`}
                    value={language}
                    onChange={(event) => {
                      if (
                        event.currentTarget.value === LessonLanguage.EN ||
                        event.currentTarget.value === LessonLanguage.VI
                      ) {
                        setLanguage(event.currentTarget.value);
                      }
                    }}
                  >
                    <option value={LessonLanguage.EN}>{translate('English')}</option>
                    <option value={LessonLanguage.VI}>{translate('Vietnamese')}</option>
                  </select>
                </div>
                <div className="preparation-field">
                  <label htmlFor={`${id}-duration`}>{translate('Length')}</label>
                  <select
                    id={`${id}-duration`}
                    value={duration}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === '60' || value === '180' || value === '300') {
                        setDuration(value);
                      }
                    }}
                  >
                    <option value="60">{translate('1 minute')}</option>
                    <option value="180">{translate('3 minutes')}</option>
                    <option value="300">{translate('5 minutes')}</option>
                  </select>
                </div>
              </div>
            </details>
            {section && (
              <section
                className="preparation-sources"
                aria-label={translate('Exact passages used')}
              >
                <div className="preparation-section-heading">
                  <h3>{translate('Exact passages used')}</h3>
                  <span aria-live="polite">{selectedPassages.length} / 8</span>
                </div>
                <div className="preparation-field preparation-search">
                  <label className="preparation-screen-reader" htmlFor={`${id}-search`}>
                    {translate('Search passages')}
                  </label>
                  <input
                    id={`${id}-search`}
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.currentTarget.value);
                    }}
                    placeholder={translate('Search passages')}
                  />
                </div>
                <div
                  className="preparation-source-list"
                  role="region"
                  tabIndex={0}
                  aria-label={translate('Approved passages')}
                >
                  {matchingPassages.map((passage) =>
                    renderPassage(passage, sectionPassages.indexOf(passage), true),
                  )}
                  {!matchingPassages.length && (
                    <p className="preparation-help">
                      {translate('No passages match your search.')}
                    </p>
                  )}
                </div>
                {!selectedPassages.length && (
                  <p className="preparation-help">
                    {translate('Select at least one approved passage.')}
                  </p>
                )}
                {(sectionPassages.length > 8 || selectedPassages.length > 8) && (
                  <p className="preparation-help">
                    {translate(
                      'Choose up to eight exact passages, including relevant corrections. Narrow the source selection if more are needed.',
                    )}
                  </p>
                )}
              </section>
            )}
            {renderInstructions()}
          </>
        )}
        {step === PreparationStep.REVIEW && (
          <div className="preparation-review">
            <section>
              <div className="preparation-section-heading">
                <h3>{translate('Content')}</h3>
                <button
                  type="button"
                  onClick={() => {
                    chooseStep(PreparationStep.CONTENT);
                  }}
                >
                  {translate('Edit content')}
                </button>
              </div>
              <p className="preparation-objective">{objective}</p>
              <dl className="preparation-review-fields">
                <div>
                  <dt>{translate('Approved source')}</dt>
                  <dd>{revision?.title}</dd>
                </div>
                <div>
                  <dt>{translate('Concept or section')}</dt>
                  <dd>{section?.title}</dd>
                </div>
                <div>
                  <dt>{translate('Audience')}</dt>
                  <dd>{audience}</dd>
                </div>
                <div>
                  <dt>{translate('Language')}</dt>
                  <dd>{languageLabel}</dd>
                </div>
                <div>
                  <dt>{translate('Length')}</dt>
                  <dd>{durationLabel}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>{translate('Exact passages used')}</h3>
              {selectedPassages.map((passage) =>
                renderPassage(passage, sectionPassages.indexOf(passage), false),
              )}
            </section>
            {instructions.trim() && (
              <section>
                <h3>{translate('Teacher instructions')}</h3>
                <p className="preparation-exact-text">{instructions}</p>
              </section>
            )}
            <details className="preparation-allowance">
              <summary>{translate('Generation allowance')}</summary>
              <p>
                {translate(
                  'Generation uses an allowance only after you confirm. Students cannot start generation.',
                )}
              </p>
            </details>
          </div>
        )}
      </fieldset>
      <footer className="preparation-footer">
        {step !== PreparationStep.CONTENT && (
          <button
            type="button"
            className="preparation-back"
            disabled={busy}
            onClick={() => {
              chooseStep(PreparationStep.CONTENT);
            }}
          >
            {translate('Back')}
          </button>
        )}
        <button
          className="preparation-primary"
          type="submit"
          disabled={!canSubmit}
          aria-busy={busy}
        >
          {translate(step === PreparationStep.REVIEW ? 'Create and generate' : 'Continue')}
        </button>
      </footer>
    </form>
  );
}
