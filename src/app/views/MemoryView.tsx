import { useState } from 'react';
import { MEMORY, type MemoryKind } from '../mock/data';
import Icon from '../components/Icon';

const ORDER: MemoryKind[] = ['Treatment', 'Pattern', 'Instruction', 'Fact'];

const BLURB: Record<MemoryKind, string> = {
  Treatment: 'Something you and the counterparty have already agreed. Stops the panel re-raising it.',
  Pattern: 'A defect that recurs. Tells the panel where to look first.',
  Instruction: 'A standing rule of yours. Outranks a built-in agent’s judgement.',
  Fact: 'Something true about the fund that the deliverable may not reflect.',
};

export default function MemoryView() {
  const [entries, setEntries] = useState(MEMORY);
  const toggle = (id: string) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Memory</h1>
          <p className="page-sub">
            What the workspace carries between reviews, so the same thing is not re-litigated every period. Written as
            rules, not notes — every agent on every review in scope reads them.
          </p>
        </div>
        <button className="button primary" type="button">
          <Icon name="plus" /> New entry
        </button>
      </header>

      {ORDER.map((kind) => {
        const group = entries.filter((e) => e.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} className="memory-section">
            <div className="memory-section-head">
              <h2 className="section-title">{kind}</h2>
              <p className="section-blurb">{BLURB[kind]}</p>
            </div>

            {group.map((e) => (
              <article key={e.id} className={e.enabled ? 'memory-card' : 'memory-card off'}>
                <p className="memory-text">{e.text}</p>
                <div className="memory-foot">
                  <span className="memory-source">
                    {e.source} · {e.createdAt}
                  </span>
                  <div className="memory-switches">
                    <span className={e.inScope ? 'chip mint' : 'chip'}>
                      {e.inScope ? 'In scope on Q1 2026' : 'Out of scope on Q1 2026'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={e.enabled}
                      className={e.enabled ? 'switch on' : 'switch'}
                      onClick={() => toggle(e.id)}
                    >
                      <span className="switch-thumb" />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </section>
        );
      })}

      <p className="page-note">
        An entry applies only when <b>both</b> switches are on. Turning one off and re-running is how you prove what a
        rule was actually doing.
      </p>
    </div>
  );
}
