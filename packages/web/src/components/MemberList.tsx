import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import type { Agent } from '../lib/types';
import { Avatar, StatusDot } from './ui';
import AgentProfile from './AgentProfile';

function Countdown({ resetAt }: { resetAt?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!resetAt) return <span>waiting for limits…</span>;
  const secs = Math.max(0, Math.floor((new Date(resetAt).getTime() - now) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return <span>resets in {m}:{String(s).padStart(2, '0')}</span>;
}

export default function MemberList({ agents, onNewAgent }: { agents: Agent[]; onNewAgent: () => void }) {
  const { parkedAgents } = useServer();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const managers = agents.filter((a) => a.isManager);
  const rest = agents.filter((a) => !a.isManager);

  const Row = ({ a }: { a: Agent }) => {
    const parked = parkedAgents[a.id];
    const active = a.status === 'THINKING' || a.status === 'WORKING';
    return (
      <div
        onClick={() => setSelectedId(a.id)}
        title={`View ${a.name}'s profile`}
        className="flex items-start gap-2.5 px-2 py-1.5 rounded-lg hover:bg-ink-750 transition-colors group cursor-pointer"
      >
        <div className="relative">
          <Avatar name={a.name} url={a.avatarUrl} size={34} ring={a.isManager ? 'ring-2 ring-clay' : undefined} />
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-ink-800">
            <StatusDot status={a.status} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={clsx('text-sm font-medium truncate', a.isManager ? 'text-clay' : 'text-cream-100')}>{a.name}</span>
            <span className="text-[10px] uppercase text-ink-500">{a.modelClass.toLowerCase()}</span>
          </div>
          {parked ? (
            <div className="text-xs text-amber-400 animate-pulse-dot">⏳ <Countdown resetAt={parked.resetAt} /></div>
          ) : active && a.thinkingLine ? (
            <div className="text-xs text-cream-400 truncate animate-fade-in">{a.thinkingLine}</div>
          ) : (
            <div className="text-xs text-ink-500 truncate">{a.statusText || a.bio || a.status.toLowerCase()}</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside className="w-60 shrink-0 bg-ink-800 border-l border-ink-900 flex flex-col">
      <div className="h-14 flex items-center justify-between px-4 border-b border-ink-900">
        <span className="text-xs uppercase tracking-wide text-ink-500 font-semibold">Members — {agents.length}</span>
        <button onClick={onNewAgent} className="text-ink-500 hover:text-clay text-lg leading-none">+</button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {managers.length > 0 && (
          <>
            <div className="text-[11px] uppercase tracking-wide text-clay/70 px-2 mb-1 mt-1 font-semibold">Manager</div>
            {managers.map((a) => <Row key={a.id} a={a} />)}
          </>
        )}
        <div className="text-[11px] uppercase tracking-wide text-ink-500 px-2 mb-1 mt-3 font-semibold">Agents</div>
        {rest.length === 0 && <p className="text-xs text-ink-500 px-2 py-3">No agents yet. Create one to get started.</p>}
        {rest.map((a) => <Row key={a.id} a={a} />)}
      </div>
      {selected && <AgentProfile agent={selected} onClose={() => setSelectedId(null)} />}
    </aside>
  );
}
