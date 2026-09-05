/**
 * The panel. Each agent is a prompt with a job, run against the connected
 * Manyfold agent on every pass, and each reports its own count — including zero.
 *
 * The prompts are the product's configuration surface: there are no switches for
 * tie-break rules, only prose, which is why every prompt here is editable.
 */

import { useState } from 'react';
import type { PanelAgent, Workspace } from '../../shared/types';
import { send } from '../api';
import { errorText } from '../lib';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';

export default function AgentsView({
  workspace,
  reload,
}: {
  workspace: Workspace | null;
  reload: (quiet?: boolean) => Promise<void>;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<PanelAgent | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      await reload(true);
      return true;
    } catch (caught) {
      setError(errorText(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const editButton = (agent: PanelAgent) => (
    <button
      className="icon-button"
      type="button"
      title="Edit"
      aria-label={`Edit ${agent.name}`}
      onClick={() => setEditing(agent)}
    >
      <Icon name="edit" />
    </button>
  );

  const promptToggle = (key: string, name: string) => (
    <button
      className={openKey === key ? 'icon-button open' : 'icon-button'}
      type="button"
      title="Prompt"
      aria-expanded={openKey === key}
      aria-label={`${openKey === key ? 'Hide' : 'Show'} the prompt for ${name}`}
      onClick={() => setOpenKey(openKey === key ? null : key)}
    >
      <Icon name="chevron" />
    </button>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Agents</h1>
          {workspace?.lastPass && (
            <p className="page-scope" title="Every count below is from this pass">
              <Icon name="reviews" size={14} /> Last pass · {workspace.lastPass.reviewName}
            </p>
          )}
        </div>
        <button className="button primary" type="button" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add agent
        </button>
      </header>

      {error && <div className="notice error">{error}</div>}
      {!workspace && <p className="empty-note">Loading…</p>}

      {workspace && !workspace.panelReady && (
        <div className="notice">
          No agent connected, so a pass cannot run. Connect one under <b>Connections</b>.
        </div>
      )}

      {workspace && (
        <div className="table-card">
          {workspace.panelAgents.map((agent) => (
            <article key={agent.key} className={agent.enabled ? 'agent-row' : 'agent-row off'}>
              <div className="agent-row-main">
                <h2 className="agent-name">
                  {agent.name}
                  {!agent.builtin && <span className="chip">yours</span>}
                  {agent.modified && <span className="chip">modified</span>}
                </h2>
                {agent.purpose && <p className="agent-purpose">{agent.purpose}</p>}
                <span className="agent-last">{lastResult(workspace, agent)}</span>
              </div>

              <div className="agent-row-controls">
                {editButton(agent)}
                {promptToggle(agent.key, agent.name)}
                <button
                  type="button"
                  role="switch"
                  aria-checked={agent.enabled}
                  aria-label={`Run ${agent.name} on every pass`}
                  className={agent.enabled ? 'switch on' : 'switch'}
                  disabled={busy}
                  onClick={() => void act(() => send('PATCH', `/api/panel-agents/${agent.key}`, { enabled: !agent.enabled }))}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {openKey === agent.key && <pre className="prompt-box">{agent.prompt}</pre>}
            </article>
          ))}
        </div>
      )}

      {workspace && (
        <section className="consolidator">
          <h2 className="section-title">{workspace.consolidator.name}</h2>

          <div className="table-card">
            <article className="agent-row">
              <div className="agent-row-main">
                <p className="agent-purpose">{workspace.consolidator.purpose}</p>
              </div>
              <div className="agent-row-controls">
                {editButton(workspace.consolidator)}
                {promptToggle('consolidator', workspace.consolidator.name)}
              </div>
              {openKey === 'consolidator' && <pre className="prompt-box">{workspace.consolidator.prompt}</pre>}
            </article>
          </div>
        </section>
      )}

      {editing && (
        <AgentDialog
          agent={editing === 'new' ? null : editing}
          busy={busy}
          act={act}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** What this agent reported on the most recent completed pass. The pass it came
 *  from is named once in the page header, so the row carries only the count. */
function lastResult(workspace: Workspace, agent: PanelAgent): React.ReactNode {
  if (!agent.enabled) return 'Switched off';
  const pass = workspace.lastPass;
  const result = pass?.agents.find((entry) => entry.key === agent.key);
  if (!pass || !result) return 'Not run yet';
  if (result.error) return <b className="nothing">did not answer</b>;
  return result.findings === 0 ? (
    <b className="nothing">nothing found</b>
  ) : (
    <b>{result.findings} findings</b>
  );
}

function AgentDialog({
  agent,
  busy,
  act,
  onClose,
}: {
  agent: PanelAgent | null;
  busy: boolean;
  act: (run: () => Promise<unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [purpose, setPurpose] = useState(agent?.purpose ?? '');
  const [prompt, setPrompt] = useState(agent?.prompt ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const consolidator = agent?.role === 'consolidator';

  const save = () =>
    void act(() =>
      agent
        ? send('PATCH', `/api/panel-agents/${agent.key}`, {
            name: name.trim(),
            purpose: purpose.trim(),
            prompt: prompt.trim(),
          })
        : send('POST', '/api/panel-agents', {
            name: name.trim(),
            purpose: purpose.trim(),
            prompt: prompt.trim(),
          }),
    ).then((ok) => ok && onClose());

  return (
    <Modal
      title={agent ? agent.name : 'New agent'}
      sub={
        consolidator
          ? 'The one prompt that merges, assigns and drafts. It sees every agent’s findings at once.'
          : 'One job, one prompt. It reads the documents on its own and reports what it finds.'
      }
      wide
      onClose={onClose}
    >
      <div className="dialog-form">
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Cephalus allocation watch" />
        </Field>
        {!consolidator && (
          <Field label="What it is for" hint="One line, shown on this page.">
            <input
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="Watches every expense for a missing or stale allocation."
            />
          </Field>
        )}
        <Field
          label="Prompt"
          hint="Written to the agent verbatim, ahead of the review, the documents and the memory in scope."
        >
          <textarea
            className="prompt-editor"
            rows={14}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        <div className="dialog-foot">
          {agent && !agent.builtin && agent.role === 'panel' && (
            <button
              className={confirmDelete ? 'button danger small' : 'button danger-outline small'}
              type="button"
              disabled={busy}
              onClick={() =>
                confirmDelete
                  ? void act(() => send('DELETE', `/api/panel-agents/${agent.key}`)).then((ok) => ok && onClose())
                  : setConfirmDelete(true)
              }
            >
              {confirmDelete ? 'Delete permanently' : 'Delete'}
            </button>
          )}
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || !name.trim() || !prompt.trim()}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
