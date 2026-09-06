/**
 * Ctrl+Y — the shell.
 *
 * A workspace app: a persistent left rail for workspace-level navigation and a
 * single working area beside it. Routing is location.hash, no router dependency
 * (`#reviews`, `#review/<id>`, `#people`, …).
 *
 * The workspace payload — people, memory, the panel and the review list — is
 * loaded once here and handed down, so the rail's open count and every page
 * read the same numbers. Connections keeps its own lazy /api/state load, since
 * the connect handshake is the only thing that needs it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppState, Workspace } from '../shared/types';
import { api, onUnauthorized } from './api';
import { useResource } from './lib';
import ChatView from './components/ChatView';
import SettingsView from './components/SettingsView';
import PasswordGate from './components/PasswordGate';
import Avatar from './components/Avatar';
import Icon from './components/Icon';
import Logo from './components/Logo';
import Skeleton from './components/Skeleton';
import ReviewsView from './views/ReviewsView';
import ReviewDetailView from './views/ReviewDetailView';
import PeopleView from './views/PeopleView';
import MemoryView from './views/MemoryView';
import AgentsView from './views/AgentsView';

type Route = 'reviews' | 'review' | 'people' | 'memory' | 'agents' | 'connections';

const ROUTES: Route[] = ['reviews', 'review', 'people', 'memory', 'agents', 'connections'];

const NAV: { key: Route; label: string; icon: string }[] = [
  { key: 'reviews', label: 'Reviews', icon: 'reviews' },
  { key: 'people', label: 'People', icon: 'people' },
  { key: 'memory', label: 'Memory', icon: 'memory' },
  { key: 'agents', label: 'Agents', icon: 'agents' },
  { key: 'connections', label: 'Connections', icon: 'plug' },
];

interface Location {
  route: Route;
  id: string;
}

function parseHash(): Location {
  const [key, id = ''] = location.hash.replace(/^#\/?/, '').split('/');
  const route = (ROUTES as string[]).includes(key) ? (key as Route) : 'reviews';
  return route === 'review' && !id ? { route: 'reviews', id: '' } : { route, id };
}

export default function App() {
  const [place, setPlace] = useState<Location>(parseHash);
  const [gateOpen, setGateOpen] = useState(false);
  const [state, setState] = useState<AppState | null>(null);
  const [stateError, setStateError] = useState('');
  const [connTab, setConnTab] = useState<'chat' | 'settings'>('settings');
  const workspace = useResource<Workspace>('/api/workspace');
  const reloadWorkspace = workspace.reload;

  useEffect(() => {
    onUnauthorized(() => setGateOpen(true));
    const onHash = () => setPlace(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      onUnauthorized(null);
    };
  }, []);

  const refreshState = useCallback(async () => {
    try {
      setState(await api<AppState>('/api/state'));
      setStateError('');
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // Only the inherited connect screens need /api/state.
  useEffect(() => {
    if (place.route === 'connections' && !state && !stateError) void refreshState();
  }, [place.route, state, stateError, refreshState]);

  const go = useCallback((route: Route, id = '') => {
    const hash = id ? `#${route}/${id}` : `#${route}`;
    if (location.hash === hash) setPlace({ route, id });
    else location.hash = hash;
  }, []);

  // The gate closes only once a call actually gets through with the new password.
  const unlock = useCallback(async () => {
    try {
      await api<Workspace>('/api/workspace');
      setGateOpen(false);
      await reloadWorkspace();
      setState(null);
      setStateError('');
    } catch {
      /* PasswordGate reports the refusal itself. */
    }
  }, [reloadWorkspace]);

  const openIssues = workspace.data?.openIssues ?? 0;
  const self = workspace.data?.people.find((person) => person.isSelf);

  return (
    <div className="app">
      <nav className="rail" aria-label="Workspace">
        <div className="rail-brand">
          <Logo />
        </div>

        <div className="rail-nav">
          {NAV.map((item) => {
            const active = place.route === item.key || (place.route === 'review' && item.key === 'reviews');
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
          <Avatar id={self?.id} name="You" isSelf />
          <span className="rail-identity">
            <b>Fund manager</b>
            <span>{self?.org ?? 'Workspace'}</span>
          </span>
        </div>
      </nav>

      <main className="work">
        {workspace.error && place.route !== 'connections' && (
          <div className="page">
            <div className="notice error">
              Could not reach the API: {workspace.error}{' '}
              <button className="link" type="button" onClick={() => void reloadWorkspace()}>
                Retry
              </button>
            </div>
          </div>
        )}

        {!workspace.error && (
          <>
            {place.route === 'reviews' && (
              <ReviewsView
                workspace={workspace.data}
                loading={workspace.loading}
                reload={reloadWorkspace}
                onOpen={(id) => go('review', id)}
              />
            )}
            {place.route === 'review' && (
              <ReviewDetailView
                key={place.id}
                reviewId={place.id}
                workspace={workspace.data}
                onBack={() => go('reviews')}
                reloadWorkspace={reloadWorkspace}
              />
            )}
            {place.route === 'people' && <PeopleView workspace={workspace.data} reload={reloadWorkspace} />}
            {place.route === 'memory' && <MemoryView workspace={workspace.data} reload={reloadWorkspace} />}
            {place.route === 'agents' && <AgentsView workspace={workspace.data} reload={reloadWorkspace} />}
          </>
        )}

        {place.route === 'connections' && (
          <div className="page">
            <header className="page-head">
              <div>
                <h1 className="page-title">Connections</h1>
                <p className="page-sub">The Manyfold agents this workspace runs its panel on.</p>
              </div>
              <div className="tabs">
                <button
                  className={connTab === 'settings' ? 'tab active' : 'tab'}
                  type="button"
                  onClick={() => setConnTab('settings')}
                >
                  Connected agents
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

            {stateError && (
              <div className="notice error">
                Could not reach the API: {stateError}{' '}
                <button className="link" type="button" onClick={() => void refreshState()}>
                  Retry
                </button>
              </div>
            )}

            {!state && !stateError && <Skeleton shape="stack" rows={3} />}

            {state &&
              (connTab === 'chat' ? (
                <ChatView agents={state.agents} initialSession={state.connect.session} refreshState={refreshState} />
              ) : (
                <SettingsView
                  agents={state.agents}
                  initialSession={state.connect.session}
                  refreshState={async () => {
                    await refreshState();
                    // Connecting or disconnecting changes whether a pass can run.
                    await reloadWorkspace(true);
                  }}
                />
              ))}
          </div>
        )}
      </main>

      {gateOpen && <PasswordGate onSubmitted={unlock} />}
    </div>
  );
}
