import { useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useAuth } from '../state/AuthContext';
import { useNotifications } from '../state/NotificationContext';
import { servers as serversApi, channels as channelsApi } from '../lib/api';
import type { Server, Channel } from '../lib/types';
import type { View } from '../pages/AppPage';
import { Avatar } from './ui';

interface Props {
  view: View;
  onSelectView: (v: View) => void;
  onSelectChannel: (c: Channel) => void;
  onSelectServer: (s: Server) => void;
  onNewAgent: () => void;
}

// Primary navigation. Chat expands into the channel list below it.
const NAV: { key: View; label: string; icon: JSX.Element; tourId?: string }[] = [
  { key: 'chat', label: 'Chat', icon: <IconChat /> },
  { key: 'brain', label: 'Brain', icon: <IconBrain />, tourId: 'nav-brain' },
  { key: 'tasks', label: 'Tasks', icon: <IconTasks />, tourId: 'nav-tasks' },
  { key: 'workflows', label: 'Workflows', icon: <IconWorkflows />, tourId: 'nav-workflows' },
  { key: 'triggers', label: 'Triggers', icon: <IconTriggers />, tourId: 'nav-triggers' },
  { key: 'activity', label: 'Activity', icon: <IconActivity /> },
  { key: 'usage', label: 'Usage', icon: <IconUsage /> },
  { key: 'settings', label: 'Settings', icon: <IconSettings /> },
];

export default function Sidebar({ view, onSelectView, onSelectChannel, onSelectServer, onNewAgent }: Props) {
  const { servers, activeServer, channels, activeChannel, refreshServers } = useServer();
  const { user, logout } = useAuth();
  const { addToast } = useNotifications();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [creatingServer, setCreatingServer] = useState(false);
  const [serverName, setServerName] = useState('');
  const [addingChannel, setAddingChannel] = useState(false);
  const [channelName, setChannelName] = useState('');

  const createServer = async () => {
    if (!serverName.trim()) return;
    try {
      const { server } = await serversApi.create(serverName.trim());
      await refreshServers();
      onSelectServer(server);
      setServerName('');
      setCreatingServer(false);
      setSwitcherOpen(false);
    } catch (e) {
      addToast('Failed to create workspace', (e as Error).message, 'error');
    }
  };

  const addChannel = async () => {
    if (!activeServer || !channelName.trim()) return;
    try {
      const { channel } = await channelsApi.create(activeServer.id, channelName.trim().toLowerCase().replace(/\s+/g, '-'));
      setChannelName('');
      setAddingChannel(false);
      onSelectChannel(channel);
      await refreshServers();
    } catch (e) {
      addToast('Failed to add channel', (e as Error).message, 'error');
    }
  };

  return (
    <aside className="w-64 shrink-0 flex flex-col bg-ink-900 border-r border-ink-800">
      {/* Workspace switcher */}
      <div className="relative p-3 border-b border-ink-800">
        <button
          onClick={() => setSwitcherOpen((o) => !o)}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-ink-800 transition-colors group"
        >
          <div className="w-8 h-8 rounded-lg bg-clay flex items-center justify-center shrink-0 text-white">
            <IconLogo />
          </div>
          <div className="min-w-0 flex-1 text-left">
            <div className="text-sm font-semibold text-cream-50 truncate">{activeServer?.name ?? 'No workspace'}</div>
            <div className="text-[11px] text-ink-500">Workspace</div>
          </div>
          <svg className="w-4 h-4 text-ink-500 group-hover:text-cream-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {switcherOpen && (
          <div className="absolute left-3 right-3 top-full mt-1 z-30 bg-ink-800 border border-ink-700 rounded-xl shadow-2xl overflow-hidden animate-fade-in">
            <div className="max-h-64 overflow-y-auto py-1">
              {servers.map((s) => (
                <button key={s.id}
                  onClick={() => { onSelectServer(s); setSwitcherOpen(false); }}
                  className={clsx('w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors', s.id === activeServer?.id ? 'bg-ink-700' : 'hover:bg-ink-750')}>
                  <div className="w-6 h-6 rounded-md bg-ink-600 flex items-center justify-center text-[10px] font-bold text-cream-100 shrink-0">
                    {s.name.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm text-cream-100 truncate">{s.name}</span>
                </button>
              ))}
            </div>
            <div className="border-t border-ink-700 p-1">
              {creatingServer ? (
                <input autoFocus value={serverName} onChange={(e) => setServerName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createServer(); if (e.key === 'Escape') setCreatingServer(false); }}
                  placeholder="Workspace name"
                  className="w-full text-sm bg-ink-850 text-cream-100 rounded-lg px-2.5 py-1.5 border border-ink-600 focus:outline-none focus:border-clay" />
              ) : (
                <button onClick={() => setCreatingServer(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-cream-300 hover:bg-ink-750 transition-colors">
                  <span className="text-clay text-base leading-none">+</span> New workspace
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2">
        {NAV.map((item) => (
          <div key={item.key}>
            <button
              onClick={() => onSelectView(item.key)}
              data-tour={item.tourId}
              className={clsx(
                'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                view === item.key ? 'bg-ink-750 text-cream-50 font-medium' : 'text-cream-300 hover:bg-ink-800 hover:text-cream-100',
              )}
            >
              <span className={clsx('shrink-0', view === item.key ? 'text-clay' : 'text-ink-500')}>{item.icon}</span>
              {item.label}
            </button>

            {/* Channels nested under Chat */}
            {item.key === 'chat' && (
              <div className="mt-1 mb-2 pl-3">
                <div className="flex items-center justify-between pl-2 pr-1 mb-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-ink-600 font-semibold">Channels</span>
                  <button onClick={() => setAddingChannel((a) => !a)} className="text-ink-600 hover:text-clay text-base leading-none">+</button>
                </div>
                {addingChannel && (
                  <input autoFocus value={channelName} onChange={(e) => setChannelName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addChannel(); if (e.key === 'Escape') setAddingChannel(false); }}
                    placeholder="new-channel"
                    className="w-full text-sm bg-ink-850 text-cream-100 rounded-lg px-2.5 py-1.5 mb-1 border border-ink-600 focus:outline-none focus:border-clay" />
                )}
                {channels.map((c) => (
                  <button key={c.id}
                    onClick={() => onSelectChannel(c)}
                    className={clsx(
                      'w-full flex items-center gap-1.5 pl-2 pr-2 py-1.5 rounded-lg text-sm transition-colors',
                      view === 'chat' && activeChannel?.id === c.id ? 'bg-ink-750 text-cream-50' : 'text-cream-400 hover:bg-ink-800 hover:text-cream-200',
                    )}>
                    <span className="text-ink-600">#</span> {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* Footer: new agent + account */}
      <div className="p-2 border-t border-ink-800 space-y-1">
        <button onClick={onNewAgent}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-ink-800 hover:bg-clay hover:text-white text-cream-200 text-sm font-medium transition-colors">
          <span className="text-base leading-none">+</span> New agent
        </button>
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg group">
          <Avatar name={user?.displayName ?? '?'} size={28} />
          <span className="text-sm text-cream-200 truncate flex-1">{user?.displayName ?? 'You'}</span>
          <button onClick={logout} title="Log out"
            className="text-ink-500 hover:text-red-400 transition-colors p-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}

// ── Icons (line style, distinct from Discord's filled glyphs) ─────────────────
function IconLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
    </svg>
  );
}
function IconChat() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}
function IconBrain() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /></svg>;
}
function IconTasks() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>;
}
function IconUsage() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>;
}
function IconWorkflows() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /><path d="M9 6h6a2 2 0 0 1 2 2v7" /></svg>;
}
function IconActivity() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>;
}
function IconTriggers() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>;
}
function IconSettings() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
}
