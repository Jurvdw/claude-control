import { useEffect, useRef, useState } from 'react';
import { useServer } from '../state/ServerContext';
import { search as searchApi } from '../lib/api';
import type { SearchResults, Channel } from '../lib/types';
import type { View } from '../pages/AppPage';

interface Props {
  initialQuery?: string;
  onClose: () => void;
  onSelectChannel: (c: Channel) => void;
  onSelectView: (v: View) => void;
}

const EMPTY: SearchResults = { messages: [], notes: [], tasks: [], agents: [], workflows: [] };

export default function SearchModal({ initialQuery = '', onClose, onSelectChannel, onSelectView }: Props) {
  const { activeServer, channels } = useServer();
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounced query.
  useEffect(() => {
    if (!activeServer || q.trim().length < 2) { setResults(EMPTY); return; }
    setLoading(true);
    const t = setTimeout(() => {
      searchApi.query(activeServer.id, q.trim())
        .then(({ results }) => setResults(results))
        .catch(() => setResults(EMPTY))
        .finally(() => setLoading(false));
    }, 220);
    return () => clearTimeout(t);
  }, [q, activeServer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (fn: () => void) => { fn(); onClose(); };
  const openChannel = (channelId: string | null) => {
    const c = channels.find((x) => x.id === channelId);
    if (c) go(() => onSelectChannel(c));
  };

  const total = results.messages.length + results.notes.length + results.tasks.length + results.agents.length + results.workflows.length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-xl bg-ink-850 border border-ink-700 rounded-2xl shadow-2xl overflow-hidden animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 h-14 border-b border-ink-800">
          <svg className="w-5 h-5 text-ink-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" strokeLinecap="round" /></svg>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages, notes, tasks, agents, workflows…"
            className="flex-1 bg-transparent text-cream-100 placeholder:text-ink-500 focus:outline-none text-sm" />
          <kbd className="text-[10px] text-ink-500 bg-ink-800 border border-ink-700 rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {q.trim().length < 2 ? (
            <p className="text-sm text-ink-500 p-4 text-center">Type at least 2 characters.</p>
          ) : total === 0 && !loading ? (
            <p className="text-sm text-ink-500 p-4 text-center">No results for “{q}”.</p>
          ) : (
            <>
              <Group label="Messages">
                {results.messages.map((m) => (
                  <Row key={m.id} onClick={() => openChannel(m.channelId)}
                    icon="💬" title={`${m.who} in #${m.channelName ?? '?'}`} sub={m.excerpt} />
                ))}
              </Group>
              <Group label="Brain notes">
                {results.notes.map((n) => (
                  <Row key={n.id} onClick={() => go(() => onSelectView('brain'))}
                    icon="🧠" title={`${n.folder ? n.folder + '/' : ''}${n.title}`} sub={n.summary} />
                ))}
              </Group>
              <Group label="Tasks">
                {results.tasks.map((t) => (
                  <Row key={t.id} onClick={() => go(() => onSelectView('tasks'))}
                    icon="✅" title={t.title} sub={t.status.toLowerCase()} />
                ))}
              </Group>
              <Group label="Workflows">
                {results.workflows.map((w) => (
                  <Row key={w.id} onClick={() => go(() => onSelectView('workflows'))} icon="⚙️" title={w.name} />
                ))}
              </Group>
              <Group label="Agents">
                {results.agents.map((a) => (
                  <Row key={a.id} onClick={() => go(() => onSelectView('chat'))} icon="🤖" title={a.name} sub={a.description} />
                ))}
              </Group>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode[] }) {
  if (!children || children.length === 0) return null;
  return (
    <div className="mb-1">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-ink-500 font-semibold">{label}</div>
      {children}
    </div>
  );
}

function Row({ icon, title, sub, onClick }: { icon: string; title: string; sub?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-ink-750 transition-colors">
      <span className="text-base shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm text-cream-100 truncate">{title}</span>
        {sub && <span className="block text-xs text-ink-500 truncate">{sub}</span>}
      </span>
    </button>
  );
}
