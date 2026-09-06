/**
 * The panel. Each agent is a prompt with a job, run against the connected
 * Manyfold agent on every pass, and each reports its own count — including zero.
 *
 * The prompts are the product's configuration surface: there are no switches for
 * tie-break rules, only prose, which is why every prompt here is editable.
 */

import { useState } from 'react';
import type { AgentRole, PanelAgent, Workspace } from '../../shared/types';
import { send } from '../api';
import { errorText } from '../lib';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';
import Select from '../components/Select';
import Skeleton from '../components/Skeleton';

const ROLE_BLURB: Record<AgentRole, string> = {
  reviewer: 'One job, one prompt. It reads the documents on its own and reports what it finds.',
  consolidator: 'The one prompt that merges, assigns and drafts. It sees every reviewer’s findings at once.',
  retrospective:
    'The one prompt that runs when you close a review. It writes the close-out and proposes what to remember.',
};

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
            <p className="page-scope">
              <Icon name="reviews" size={14} /> Every count below is from the last pass ·{' '}
              {workspace.lastPass.reviewName}
            </p>
          )}
        </div>
        <button className="button primary" type="button" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add reviewer
        </button>
      </header>

      {error && <div className="notice error">{error}</div>}
      {!workspace && <Skeleton shape="panel" />}

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
                <TargetPicker agent={agent} workspace={workspace} busy={busy} act={act} />
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
        <>
          <Singleton
            agent={workspace.consolidator}
            open={openKey === workspace.consolidator.key}
            toggle={promptToggle}
            onEdit={() => setEditing(workspace.consolidator)}
            workspace={workspace}
            busy={busy}
            act={act}
          />
          <Singleton
            agent={workspace.retrospective}
            open={openKey === workspace.retrospective.key}
            toggle={promptToggle}
            onEdit={() => setEditing(workspace.retrospective)}
            workspace={workspace}
            busy={busy}
            act={act}
          />
        </>
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

/**
 * Which connected Manyfold agent this prompt runs on.
 *
 * A pin that names an agent no longer connected stays visible and stays selected,
 * rather than silently resetting to "Any" — the run reports it as an error, and
 * the page should say the same thing.
 */
function TargetPicker({
  agent,
  workspace,
  busy,
  act,
}: {
  agent: PanelAgent;
  workspace: Workspace;
  busy: boolean;
  act: (run: () => Promise<unknown>) => Promise<boolean>;
}) {
  const connected = workspace.connectedAgents;
  const stale = agent.agentId !== null && !connected.some((entry) => entry.agentId === agent.agentId);
  if (connected.length === 0) return null;

  return (
    <Select
      className={stale ? 'agent-target stale' : 'agent-target'}
      ariaLabel={`Which Manyfold agent ${agent.name} runs on`}
      disabled={busy}
      value={agent.agentId ?? ''}
      onChange={(value) =>
        void act(() => send('PATCH', `/api/panel-agents/${agent.key}`, { agentId: value || null }))
      }
      options={[
        { value: '', label: 'Any connected agent' },
        ...connected.map((entry) => ({ value: entry.agentId, label: entry.name })),
        ...(stale
          ? [
              {
                value: agent.agentId as string,
                label: 'Disconnected agent',
                note: 'This prompt will fail until you pick another.',
              },
            ]
          : []),
      ]}
    />
  );
}

/** One of the two roles there is exactly one of: no switch, no delete, just a prompt. */
function Singleton({
  agent,
  open,
  toggle,
  onEdit,
  workspace,
  busy,
  act,
}: {
  agent: PanelAgent;
  open: boolean;
  toggle: (key: string, name: string) => React.ReactNode;
  onEdit: () => void;
  workspace: Workspace;
  busy: boolean;
  act: (run: () => Promise<unknown>) => Promise<boolean>;
}) {
  return (
    <section className="consolidator">
      <h2 className="section-title">{agent.name}</h2>

      <div className="table-card">
        <article className="agent-row">
          <div className="agent-row-main">
            <p className="agent-purpose">{agent.purpose}</p>
          </div>
          <div className="agent-row-controls">
            <TargetPicker agent={agent} workspace={workspace} busy={busy} act={act} />
            <button className="icon-button" type="button" aria-label={`Edit ${agent.name}`} onClick={onEdit}>
              <Icon name="edit" />
            </button>
            {toggle(agent.key, agent.name)}
          </div>
          {open && <pre className="prompt-box">{agent.prompt}</pre>}
        </article>
      </div>
    </section>
  );
}

/** What this agent reported on the most recent completed pass, on any review. */
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
  const role = agent?.role ?? 'reviewer';
  const reviewer = role === 'reviewer';

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
      title={agent ? agent.name : 'New reviewer'}
      sub={ROLE_BLURB[role]}
      wide
      onClose={onClose}
    >
      <div className="dialog-form">
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Cephalus allocation watch" />
        </Field>
        {reviewer && (
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
          {agent && !agent.builtin && reviewer && (
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
