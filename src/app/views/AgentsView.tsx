import { useState } from 'react';
import { AGENTS, CONSOLIDATOR } from '../mock/data';
import Icon from '../components/Icon';

export default function AgentsView() {
  const [openKey, setOpenKey] = useState<string | null>('cephalus');
  const [agents, setAgents] = useState(AGENTS);

  const toggle = (key: string) =>
    setAgents((prev) => prev.map((a) => (a.key === key ? { ...a, enabled: !a.enabled } : a)));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Agent panel</h1>
          <p className="page-sub">
            A review is not one model call. Each agent has a different job, so each gets its own prompt and reports its
            own count — including zero.
          </p>
        </div>
        <button className="button primary" type="button">
          <Icon name="plus" /> Add agent
        </button>
      </header>

      <div className="agent-grid">
        {agents.map((a) => (
          <article key={a.key} className={a.enabled ? 'agent-tile' : 'agent-tile off'}>
            <header className="agent-tile-head">
              <div>
                <h2 className="agent-name">
                  {a.name}
                  {!a.builtin && <span className="chip mint">yours</span>}
                  {a.modified && <span className="chip">modified</span>}
                </h2>
                <p className="agent-purpose">{a.purpose}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={a.enabled}
                className={a.enabled ? 'switch on' : 'switch'}
                onClick={() => toggle(a.key)}
              >
                <span className="switch-thumb" />
              </button>
            </header>

            <div className="agent-tile-foot">
              <span className="agent-last">
                Last pass:{' '}
                {a.findings === 0 ? (
                  <b className="nothing">nothing found</b>
                ) : (
                  <b className="tnum">{a.findings} findings</b>
                )}
              </span>
              <button className="button ghost small" type="button" onClick={() => setOpenKey(openKey === a.key ? null : a.key)}>
                {openKey === a.key ? 'Hide prompt' : 'View prompt'}
              </button>
            </div>

            {openKey === a.key && (
              <pre className="prompt-box">{a.prompt}</pre>
            )}
          </article>
        ))}
      </div>

      <section className="consolidator-card">
        <header className="agent-tile-head">
          <div>
            <h2 className="agent-name">
              {CONSOLIDATOR.name}
              <span className="chip">designated</span>
            </h2>
            <p className="agent-purpose">{CONSOLIDATOR.purpose}</p>
          </div>
          <button className="button small" type="button" onClick={() => setOpenKey(openKey === 'consolidator' ? null : 'consolidator')}>
            {openKey === 'consolidator' ? 'Hide prompt' : 'View prompt'}
          </button>
        </header>
        {openKey === 'consolidator' && <pre className="prompt-box">{CONSOLIDATOR.prompt}</pre>}
        <p className="page-note tight">
          Tie-break rules live in this prompt, not in configuration switches. Prose is more expressive than three
          toggles, and you can override any individual ruling anyway.
        </p>
      </section>
    </div>
  );
}
