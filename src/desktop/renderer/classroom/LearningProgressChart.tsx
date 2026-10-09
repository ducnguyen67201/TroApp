import type { ReactElement } from 'react';

export interface LearningProgressPoint {
  sessionId: string;
  title: string;
  met: number;
  needsPractice: number;
  unknown: number;
  conflicting: number;
  denominator: number;
  comparable: boolean;
}

interface LearningProgressChartProps {
  lessons: LearningProgressPoint[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

/** Shows server-calculated criterion counts. Missing results never become an ability score. */
export function LearningProgressChart({
  lessons,
  selectedSessionId,
  onSelect,
}: LearningProgressChartProps): ReactElement {
  const maximum = Math.max(1, ...lessons.map((lesson) => lesson.denominator));
  return (
    <section className="learning-chart" aria-label="Skills shown by lesson">
      <div className="learning-chart-heading">
        <div>
          <h3>Skills shown by lesson</h3>
          <p>Checked criteria from your teacher’s lesson plan.</p>
        </div>
        <span className="learning-chart-axis-label">Criteria · 0–{maximum}</span>
      </div>
      <div className="learning-chart-legend">
        <span>
          <i className="learning-met" />
          Met
        </span>
        <span>
          <i className="learning-practice" />
          Needs practice
        </span>
        <span>
          <i className="learning-unknown" />
          No result shown
        </span>
        <span>
          <i className="learning-conflict" />
          Review needed
        </span>
      </div>
      {lessons.length === 0 ? (
        <p>No lesson results to show yet.</p>
      ) : (
        <div className="learning-chart-plot">
          {lessons.map((lesson) => (
            <button
              type="button"
              className="learning-chart-column"
              key={lesson.sessionId}
              aria-pressed={lesson.sessionId === selectedSessionId}
              aria-label={`${lesson.title}: ${String(lesson.met)} met, ${String(lesson.needsPractice)} need practice, ${String(lesson.unknown)} no result shown, ${String(lesson.conflicting)} need review; ${String(lesson.denominator)} criteria${lesson.comparable ? '' : ', comparison across lessons not established'}`}
              onClick={() => {
                onSelect(lesson.sessionId);
              }}
            >
              <span className="learning-chart-total">
                {lesson.denominator ? `${String(lesson.met)}/${String(lesson.denominator)}` : '—'}
                <small>met</small>
              </span>
              <span
                className="learning-chart-bar"
                style={{ height: `${String(Math.max(3, (lesson.denominator / maximum) * 160))}px` }}
              >
                {lesson.denominator > 0 && (
                  <>
                    {lesson.unknown > 0 && (
                      <span className="learning-unknown" style={{ flex: lesson.unknown }}>
                        {lesson.unknown}
                      </span>
                    )}
                    {lesson.conflicting > 0 && (
                      <span className="learning-conflict" style={{ flex: lesson.conflicting }}>
                        {lesson.conflicting}
                      </span>
                    )}
                    {lesson.needsPractice > 0 && (
                      <span className="learning-practice" style={{ flex: lesson.needsPractice }}>
                        {lesson.needsPractice}
                      </span>
                    )}
                    {lesson.met > 0 && (
                      <span className="learning-met" style={{ flex: lesson.met }}>
                        {lesson.met}
                      </span>
                    )}
                  </>
                )}
              </span>
              <span className="learning-chart-title">{lesson.title}</span>
              {!lesson.comparable && <small>Lesson criteria</small>}
            </button>
          ))}
        </div>
      )}
      <details>
        <summary>How this is counted</summary>
        <p>
          Each bar uses the approved criteria for that lesson. A result counts once per criterion,
          using the latest comparable finding. Met criteria may include support. Missing or
          conflicting results remain separate. These counts do not measure general ability.
        </p>
      </details>
    </section>
  );
}
