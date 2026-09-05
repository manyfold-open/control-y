/**
 * Turn Zero — the shell.
 *
 * A workspace app: a persistent left rail for workspace-level navigation and a
 * single working area beside it. Routing is location.hash, no router dependency.
 *
 * The Turn Zero screens are mocked end to end (src/app/mock/data.ts) and never
 * touch the API. Only Connections — the inherited chat and settings screens —
 * loads /api/state, and it does so lazily so a cold or missing worker cannot
 * block the rest of the product.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { api, onUnauthorized } from './api';
import ChatView from './components/ChatView';
import SettingsView from './components/SettingsView';
import PasswordGate from './components/PasswordGate';
import Icon from './components/Icon';
import ReviewsView from './views/ReviewsView';
import ReviewDetailView from './views/ReviewDetailView';
import PeopleView from './views/PeopleView';
import MemoryView from './views/MemoryView';
import AgentsView from './views/AgentsView';
import { ISSUES } from './mock/data';

type Route = 'reviews' | 'review' | 'people' | 'memory' | 'agents' | 'connections';

const NAV: { key: Route; label: string; icon: string }[] = [
  { key: 'reviews', label: 'Reviews', icon: 'reviews' },
  { key: 'people', label: 'People', icon: 'people' },
  { key: 'memory', label: 'Memory', icon: 'memory' },
  { key: 'agents', label: 'Agents', icon: 'agents' },
  { key: 'connections', label: 'Connections', icon: 'plug' },
];

const routeFromHash = (): Route => {
  const key = location.hash.replace('#', '').split('/')[0] as Route;
  return ['reviews', 'review', 'people', 'memory', 'agents', 'connections'].includes(key) ? key : 'reviews';
};

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [gateOpen, setGateOpen] = useState(false);
  const [connTab, setConnTab] = useState<'chat' | 'settings'>('settings');

  const refreshState = useCallback(async () => {
    try {
      const next = await api<AppState>('/api/state');
      setState(next);
      setLoadError('');
      setGateOpen(next.adminRequired && !next.adminOk);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => setGateOpen(true));
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      onUnauthorized(null);
    };
  }, []);

  // Only the inherited screens need the worker.
  useEffect(() => {
    if (route === 'connections' && !state && !loadError) void refreshState();
  }, [route, state, loadError, refreshState]);

  const go = (r: Route) => {
    location.hash = `#${r}`;
    setRoute(r);
  };

  const openIssues = ISSUES.filter((i) => i.status === 'open').length;

  return (
    <div className="app">
      <nav className="rail" aria-label="Workspace">
        <div className="rail-brand">
          <span className="rail-mark" aria-hidden>
            ◪
          </span>
          <span className="rail-wordmark">Turn Zero</span>
        </div>

        <div className="rail-nav">
          {NAV.map((item) => {
            const active = route === item.key || (route === 'review' && item.key === 'reviews');
            return (
              <button
                key={item.key}
                type="button"
                className={active ? 'rail-item active' : 'rail-item'}
                onClick={() => go(item.key)}
              >
                <Icon name={item.icon} />
                <span className="rail-label">{item.label}</span>
                {item.key === 'reviews' && openIssues > 0 && <span className="rail-count tnum">{openIssues}</span>}
              </button>
            );
          })}
        </div>

        <div className="rail-foot">
          <span className="avatar self">YOU</span>
          <span className="rail-identity">
            <b>Fund manager</b>
            <span>Ardent Capital</span>
          </span>
        </div>
      </nav>

      <main className="work">
        {route === 'reviews' && <ReviewsView onOpen={() => go('review')} />}
        {route === 'review' && <ReviewDetailView onBack={() => go('reviews')} />}
        {route === 'people' && <PeopleView />}
        {route === 'memory' && <MemoryView />}
        {route === 'agents' && <AgentsView />}

        {route === 'connections' && (
          <div className="page">
            <header className="page-head">
              <div>
                <h1 className="page-title">Connections</h1>
                <p className="page-sub">
                  The Manyfold agents this workspace runs its panel on. Nobody but you ever signs in here.
                </p>
              </div>
              <div className="tabs">
                <button
                  className={connTab === 'settings' ? 'tab active' : 'tab'}
                  type="button"
                  onClick={() => setConnTab('settings')}
                >
                  Agents
                </button>
                <button
                  className={connTab === 'chat' ? 'tab active' : 'tab'}
                  type="button"
                  onClick={() => setConnTab('chat')}
                >
                  Test chat
                </button>
              </div>
            </header>

            {loadError && (
              <div className="notice error">
                Could not reach the API: {loadError}{' '}
                <button className="link" onClick={() => void refreshState()}>
                  Retry
                </button>
              </div>
            )}

            {!state && !loadError && <p className="empty-note">Loading…</p>}

            {state &&
              (connTab === 'chat' ? (
                <ChatView agents={state.agents} initialSession={state.connect.session} refreshState={refreshState} />
              ) : (
                <SettingsView agents={state.agents} initialSession={state.connect.session} refreshState={refreshState} />
              ))}
          </div>
        )}
      </main>

      {gateOpen && <PasswordGate onSubmitted={refreshState} />}
    </div>
  );
}
