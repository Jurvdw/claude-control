import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import clsx from 'clsx';
import { useParams, useNavigate } from 'react-router-dom';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { servers as serversApi } from '../lib/api';
import type { Server, Channel } from '../lib/types';
import Sidebar from '../components/Sidebar';
import MessageFeed from '../components/MessageFeed';
import MessageComposer from '../components/MessageComposer';
import MemberList from '../components/MemberList';
import TypingIndicator from '../components/TypingIndicator';
import ApprovalsTray from '../components/ApprovalsTray';
import UpdateWatcher from '../components/UpdateWatcher';
import AgentCreateModal from '../components/AgentCreateModal';
import SearchModal from '../components/SearchModal';
import SpotlightTour from '../components/SpotlightTour';

// Heavy views are code-split so they don't bloat the initial chat bundle
// (Brain pulls in react-markdown + the graph sim; Usage pulls in charts).
const BrainPanel = lazy(() => import('../components/BrainPanel'));
const TaskPanel = lazy(() => import('../components/TaskPanel'));
const UsagePage = lazy(() => import('../components/UsagePage'));
const SettingsPanel = lazy(() => import('../components/SettingsPanel'));
const WorkflowsPanel = lazy(() => import('../components/WorkflowsPanel'));
const ActivityPanel = lazy(() => import('../components/ActivityPanel'));
const TriggersPanel = lazy(() => import('../components/TriggersPanel'));

export type View = 'chat' | 'brain' | 'tasks' | 'workflows' | 'triggers' | 'activity' | 'usage' | 'settings';

function ViewFallback() {
  return (
    <div className="flex-1 flex items-center justify-center text-ink-500">
      <div className="animate-pulse-dot text-clay text-sm font-medium">Loading…</div>
    </div>
  );
}

export default function AppPage() {
  const { serverId, channelId } = useParams();
  const nav = useNavigate();
  const { addToast } = useNotifications();
  const {
    servers, activeServer, setActiveServer, channels, activeChannel, setActiveChannel,
    agents, approvals,
  } = useServer();

  const [view, setView] = useState<View>('chat');
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showApprovals, setShowApprovals] = useState(false);
  const [search, setSearch] = useState<{ open: boolean; q: string }>({ open: false, q: '' });

  // Sync URL serverId → active server.
  useEffect(() => {
    if (servers.length === 0) return;
    if (serverId) {
      const found = servers.find((s) => s.id === serverId);
      if (found && activeServer?.id !== found.id) setActiveServer(found);
    } else if (!activeServer) {
      nav(`/${servers[0].id}`, { replace: true });
    }
  }, [servers, serverId, activeServer, setActiveServer, nav]);

  // Deep-link channelId → active channel.
  useEffect(() => {
    if (!channelId || channels.length === 0) return;
    const found = channels.find((c) => c.id === channelId);
    if (found && activeChannel?.id !== found.id) setActiveChannel(found);
  }, [channels, channelId, activeChannel, setActiveChannel]);

  // Keyboard shortcuts: `g` then a letter to navigate; `?` for help.
  useEffect(() => {
    const navKeys: Record<string, View> = { c: 'chat', b: 'brain', t: 'tasks', w: 'workflows', r: 'triggers', a: 'activity', u: 'usage', s: 'settings' };
    let gArmed = false;
    let gTimer: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (gArmed && navKeys[e.key]) { e.preventDefault(); setView(navKeys[e.key]); gArmed = false; return; }
      gArmed = false;
      if (e.key === 'g') { gArmed = true; clearTimeout(gTimer); gTimer = setTimeout(() => { gArmed = false; }, 900); }
      else if (e.key === '?') addToast('Keyboard shortcuts', 'Press g then: c chat · b brain · t tasks · w workflows · r triggers · a activity · u usage · s settings', 'info');
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(gTimer); };
  }, [addToast]);

  const onSelectServer = (s: Server) => nav(`/${s.id}`);
  const onSelectChannel = useCallback((c: Channel) => {
    setView('chat');
    setActiveChannel(c);
    if (activeServer) nav(`/${activeServer.id}/${c.id}`);
  }, [activeServer, setActiveChannel, nav]);

  const pendingApprovals = approvals.filter((a) => a.status === 'PENDING').length;

  const pauseAll = async () => {
    if (!activeServer) return;
    try {
      await serversApi.pauseAll(activeServer.id);
      addToast('All agents paused', 'The kill switch is engaged.', 'success');
    } catch (e) {
      addToast('Failed to pause agents', (e as Error).message, 'error');
    }
  };
  const resumeAll = async () => {
    if (!activeServer) return;
    try {
      await serversApi.resumeAll(activeServer.id);
      addToast('Agents resumed', undefined, 'success');
    } catch (e) {
      addToast('Failed to resume', (e as Error).message, 'error');
    }
  };

  const headerTitle =
    view === 'chat' ? (activeChannel ? `# ${activeChannel.name}` : 'Select a channel')
    : view === 'brain' ? 'Brain'
    : view === 'tasks' ? 'Tasks'
    : view === 'workflows' ? 'Workflows'
    : view === 'triggers' ? 'Triggers'
    : view === 'activity' ? 'Activity'
    : view === 'settings' ? 'Settings'
    : 'Usage';

  return (
    <div className="h-full flex text-cream-100">
      <Sidebar
        view={view}
        onSelectView={setView}
        onSelectChannel={onSelectChannel}
        onSelectServer={onSelectServer}
        onNewAgent={() => setShowAgentModal(true)}
      />

      {activeServer ? (
          <main className="flex-1 flex flex-col min-w-0 bg-ink-850">
            {/* Header */}
            <header className="h-14 shrink-0 flex items-center justify-between px-5 border-b border-ink-800">
              <div className="flex items-center gap-3 min-w-0">
                <h1 className="font-semibold text-cream-50 truncate">{headerTitle}</h1>
                {view === 'chat' && activeChannel?.topic && (
                  <span className="text-sm text-ink-500 truncate border-l border-ink-700 pl-3">{activeChannel.topic}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setSearch({ open: true, q: '' })} title="Search (messages, notes, tasks…)"
                  className="text-ink-400 hover:text-cream-200 px-2 py-1.5 rounded-lg hover:bg-ink-800 transition-colors">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" strokeLinecap="round" /></svg>
                </button>
                <button onClick={pauseAll} title="Pause all agents"
                  className="text-sm px-3 py-1.5 rounded-lg bg-ink-800 hover:bg-red-600/80 hover:text-white text-cream-300 transition-colors">
                  Pause all
                </button>
                <button onClick={resumeAll} title="Resume all agents"
                  className="text-sm px-2.5 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-cream-300 transition-colors">Resume</button>
                <button onClick={() => setShowApprovals(true)} title="Approvals"
                  className="relative text-sm px-2.5 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-cream-300 transition-colors">
                  Approvals
                  {pendingApprovals > 0 && (
                    <span className="absolute -top-1 -right-1 bg-clay text-white text-[10px] rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">{pendingApprovals}</span>
                  )}
                </button>
              </div>
            </header>

            {/* Body */}
            <div className="flex-1 flex min-h-0">
              <div className="flex-1 flex flex-col min-w-0">
                {view === 'chat' && (
                  <>
                    <MessageFeed />
                    <TypingIndicator />
                    <MessageComposer onOpenAgentModal={() => setShowAgentModal(true)} onOpenView={setView} onOpenSearch={(q) => setSearch({ open: true, q })} />
                  </>
                )}
                {view !== 'chat' && (
                  <Suspense fallback={<ViewFallback />}>
                    {view === 'brain' && <BrainPanel />}
                    {view === 'tasks' && <TaskPanel />}
                    {view === 'workflows' && <WorkflowsPanel />}
                    {view === 'triggers' && <TriggersPanel />}
                    {view === 'activity' && <ActivityPanel />}
                    {view === 'usage' && <UsagePage />}
                    {view === 'settings' && <SettingsPanel />}
                  </Suspense>
                )}
              </div>
              {view === 'chat' && <MemberList agents={agents} onNewAgent={() => setShowAgentModal(true)} />}
            </div>
          </main>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-ink-850">
          <div className="text-center max-w-sm animate-fade-in">
            <div className="text-5xl mb-4">🛰️</div>
            <h2 className="text-xl font-semibold text-cream-50">No workspace yet</h2>
            <p className="text-cream-400 mt-2 text-sm">Create your first workspace from the switcher in the top-left. A workspace is a project with a shared Brain and a team of agents.</p>
          </div>
        </div>
      )}

      {showAgentModal && <AgentCreateModal open onClose={() => setShowAgentModal(false)} />}
      {showApprovals && <ApprovalsTray onClose={() => setShowApprovals(false)} />}
      <SpotlightTour view={view} onChangeView={setView} />
      <UpdateWatcher />
      {search.open && <SearchModal initialQuery={search.q} onClose={() => setSearch({ open: false, q: '' })} onSelectChannel={onSelectChannel} onSelectView={setView} />}
    </div>
  );
}
