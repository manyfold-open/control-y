/**
 * Chat with one connected agent. History is loaded from D1 (the source of truth);
 * during a turn the live reply is rendered from `text` events, each of which carries
 * the full accumulated text — the client replaces its buffer, never appends. When
 * the turn ends the history is re-fetched, so what you see is what was persisted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ConnectedAgent, ConnectSession } from '../../shared/types';
import { api } from '../api';
import { streamChat } from '../sse';
import AgentPicker from './AgentPicker';
import ConnectPanel from './ConnectPanel';

interface HistoryResponse {
  conversation: { contextId: string | null; activeTaskId: string | null } | null;
  messages: ChatMessage[];
}

interface LiveTurn {
  status: string;
  text: string;
}

export default function ChatView(props: {
  agents: ConnectedAgent[];
  initialSession: ConnectSession | null;
  refreshState: () => Promise<void>;
}) {
  const { agents } = props;
  const [selectedId, setSelectedId] = useState<string | null>(agents[0]?.agentId ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);

  // Keep the selection valid as agents connect and disconnect.
  useEffect(() => {
    if (!selectedId || !agents.some((agent) => agent.agentId === selectedId)) {
      setSelectedId(agents[0]?.agentId ?? null);
    }
  }, [agents, selectedId]);

  const loadHistory = useCallback(async (agentId: string) => {
    const history = await api<HistoryResponse>(
      `/api/agents/${encodeURIComponent(agentId)}/messages`,
    );
    setMessages(history.messages);
  }, []);

  useEffect(() => {
    setMessages([]);
    setError('');
    if (selectedId) void loadHistory(selectedId).catch(() => undefined);
  }, [selectedId, loadHistory]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, live]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !selectedId || live) return;
    setDraft('');
    setError('');
    // Optimistic user bubble; replaced by the persisted row when history reloads.
    setMessages((current) => [
      ...current,
      {
        id: -1,
        role: 'user',
        content: text,
        status: 'complete',
        error: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setLive({ status: 'sending', text: '' });
    try {
      await streamChat(selectedId, text, (event) => {
        if (event.type === 'status') setLive((current) => ({ status: event.state, text: current?.text ?? '' }));
        if (event.type === 'text') setLive((current) => ({ status: current?.status ?? 'working', text: event.text }));
        if (event.type === 'error') setError(event.message);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLive(null);
      await loadHistory(selectedId).catch(() => undefined);
    }
  };

  const reset = async () => {
    if (!selectedId || live) return;
    if (!window.confirm('Clear this conversation? The agent will also forget its context.')) return;
    await api(`/api/agents/${encodeURIComponent(selectedId)}/messages`, { method: 'DELETE' });
    await loadHistory(selectedId);
  };

  if (agents.length === 0) {
    return (
      <section className="panel">
        <h2>Connect your first agent</h2>
        <p className="muted">
          This starter talks to agents you host on{' '}
          <a href="https://manyfold.ai" target="_blank" rel="noreferrer">
            Manyfold
          </a>
          . Connect one, then verify the wiring by chatting with it right here.
        </p>
        <ConnectPanel initialSession={props.initialSession} onConnected={props.refreshState} />
      </section>
    );
  }

  const selectedAgent = agents.find((agent) => agent.agentId === selectedId) ?? null;

  return (
    <section className="panel chat">
      <div className="chat-toolbar">
        <AgentPicker agents={agents} selectedId={selectedId} onSelect={setSelectedId} />
        {selectedAgent?.warning && <span className="warn">⚠ {selectedAgent.warning}</span>}
        <button className="button subtle" onClick={() => void reset()} disabled={!messages.length || !!live}>
          Reset conversation
        </button>
      </div>

      <div className="chat-log" ref={scroller}>
        {messages.length === 0 && !live && (
          <p className="muted center">
            Say hello — a reply here proves the connection works end to end.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={`${message.id}-${index}`} className={`bubble ${message.role}`}>
            <div className="bubble-text">{message.content || (message.error ?? '')}</div>
            {message.status === 'error' && message.error && (
              <div className="bubble-meta error">{message.error}</div>
            )}
            {message.status === 'input-required' && (
              <div className="bubble-meta">The agent is waiting for your answer.</div>
            )}
          </div>
        ))}
        {live && (
          <div className="bubble agent">
            <div className="bubble-text">{live.text || '…'}</div>
            <div className="bubble-meta">{live.status}…</div>
          </div>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={live ? 'Waiting for the agent…' : 'Message the agent (Enter to send)'}
          rows={3}
          disabled={!!live}
        />
        <button className="button primary" type="submit" disabled={!draft.trim() || !!live}>
          {live ? 'Working…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
