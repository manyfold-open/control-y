/**
 * Manage connected agents: see their status, re-run the (free) auth probe,
 * disconnect, and connect more. Re-connecting an agent that is already here
 * rotates its token in place rather than duplicating it.
 */

import { useState } from 'react';
import type { ConnectedAgent, ConnectSession } from '../../shared/types';
import { api } from '../api';
import ConnectPanel from './ConnectPanel';

export default function SettingsView(props: {
  agents: ConnectedAgent[];
  initialSession: ConnectSession | null;
  refreshState: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const verify = async (agentId: string) => {
    setBusyId(agentId);
    setError('');
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/verify`, { method: 'POST' });
      await props.refreshState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (agentId: string) => {
    setBusyId(agentId);
    setError('');
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
      setConfirmId(null);
      await props.refreshState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel">
      <h2>Connected agents</h2>
      {props.agents.length === 0 && (
        <p className="muted">No agents connected yet — connect one below.</p>
      )}

      <div className="agent-list">
        {props.agents.map((agent) => (
          <div className="agent-card" key={agent.agentId}>
            <div className="agent-card-main">
              <div className="agent-card-title">
                <strong>{agent.name}</strong>
                {agent.verified ? (
                  <span className="badge ok">verified</span>
                ) : (
                  <span className="badge warn" title={agent.warning ?? undefined}>
                    unverified
                  </span>
                )}
              </div>
              {agent.description && <p className="muted">{agent.description}</p>}
              <p className="muted small">
                {new URL(agent.rpcUrl).host} · connected {new Date(agent.connectedAt).toLocaleString()}
                {agent.expiresAt ? ` · authorization expires ${new Date(agent.expiresAt).toLocaleString()}` : ''}
              </p>
              {agent.warning && <p className="warn small">⚠ {agent.warning}</p>}
            </div>
            <div className="agent-card-actions">
              <button
                className="button subtle"
                onClick={() => void verify(agent.agentId)}
                disabled={busyId === agent.agentId}
              >
                {busyId === agent.agentId ? 'Checking…' : 'Re-verify'}
              </button>
              {confirmId === agent.agentId ? (
                <span className="row">
                  <button
                    className="button danger"
                    onClick={() => void disconnect(agent.agentId)}
                    disabled={busyId === agent.agentId}
                  >
                    Really disconnect
                  </button>
                  <button className="button subtle" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button className="button danger-outline" onClick={() => setConfirmId(agent.agentId)}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && <div className="notice error">{error}</div>}

      <h3>Connect more agents</h3>
      <p className="muted">
        Re-approving an agent that is already connected rotates its token in place — useful when an
        authorization expired.
      </p>
      <ConnectPanel initialSession={props.initialSession} onConnected={props.refreshState} />

      <h3>About this deployment</h3>
      <p className="muted">
        Agent tokens are AES-GCM encrypted in your D1 database and never sent to the browser. Set
        the <code>ADMIN_PASSWORD</code> secret to lock this page (and chat) behind a password, and{' '}
        <code>CONFIG_ENCRYPTION_KEY</code> to keep the encryption key out of the database. See the
        README for details.
      </p>
    </section>
  );
}
