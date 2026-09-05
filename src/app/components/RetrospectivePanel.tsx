/**
 * The close-out of a review, shown at the top of the review page once it is closed.
 *
 * The rules the retrospective proposed are real memory entries, written switched
 * off. The switch here is the same one the Memory page shows — this panel exists
 * so the decision is made where the evidence is, next to the issues each rule was
 * drawn from, rather than on a page listing every rule the workspace ever had.
 */

import type { Retrospective, ScopedMemoryEntry } from '../../shared/types';
import { send } from '../api';

export default function RetrospectivePanel({
  retro,
  memory,
  busy,
  act,
}: {
  retro: Retrospective;
  memory: ScopedMemoryEntry[];
  busy: boolean;
  act: (run: () => Promise<unknown>) => Promise<boolean>;
}) {
  if (retro.status === 'running') {
    return (
      <div className="notice">
        Looking back over the review — every pass, every issue, and how each one was settled. The rules it proposes will
        appear here.
      </div>
    );
  }

  if (retro.status === 'failed') {
    return (
      <div className="notice error">
        The retrospective did not complete. {retro.error} The review is still closed, and nothing was written to memory.
      </div>
    );
  }

  const live = retro.lessons.filter((lesson) => lesson.memoryId);
  const enabledCount = live.filter(
    (lesson) => memory.find((entry) => entry.id === lesson.memoryId)?.enabled,
  ).length;

  return (
    <section className="retro">
      <div className="memory-section-head">
        <h2 className="section-title">Retrospective</h2>
        <p className="section-blurb">
          {live.length === 0
            ? 'Nothing from this review was worth carrying forward.'
            : `${live.length} ${live.length === 1 ? 'rule' : 'rules'} proposed · ${enabledCount} switched on. A rule applies to future reviews only once you switch it on.`}
        </p>
      </div>

      <div className="table-card">
        {retro.summary && (
          <article className="agent-row">
            <p className="retro-summary">{retro.summary}</p>
          </article>
        )}

        {(retro.wentWell.length > 0 || retro.toChange.length > 0) && (
          <article className="agent-row retro-columns">
            {retro.wentWell.length > 0 && (
              <div>
                <h3 className="retro-heading">What worked</h3>
                <ul className="retro-list">
                  {retro.wentWell.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            {retro.toChange.length > 0 && (
              <div>
                <h3 className="retro-heading">What to change</h3>
                <ul className="retro-list">
                  {retro.toChange.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        )}

        {retro.lessons.map((lesson, index) => {
          const entry = lesson.memoryId ? memory.find((item) => item.id === lesson.memoryId) : undefined;
          const enabled = entry?.enabled ?? false;
          return (
            <article key={lesson.memoryId ?? `lesson-${index}`} className={enabled ? 'memory-row' : 'memory-row off'}>
              <p className="memory-text as-text">
                <span className="chip">{lesson.kind}</span> {lesson.text}
              </p>
              <div className="memory-foot">
                <span className="memory-source">
                  {entry ? `From ${lesson.basis.join(', ')}` : 'Could not be written to memory — copy it by hand.'}
                </span>
                {entry && (
                  <div className="memory-switches">
                    <span className="retro-state">{enabled ? 'In use' : 'Not in use yet'}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`Carry this rule into future reviews — ${lesson.text}`}
                      className={enabled ? 'switch on' : 'switch'}
                      disabled={busy}
                      onClick={() =>
                        void act(() => send('PATCH', `/api/memory/${entry.id}`, { enabled: !enabled }))
                      }
                    >
                      <span className="switch-thumb" />
                    </button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
