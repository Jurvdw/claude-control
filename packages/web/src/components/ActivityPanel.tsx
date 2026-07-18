import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { activity as activityApi } from '../lib/api';
import { onSocketEvent } from '../lib/socket';
import type { ActivityRun } from '../lib/types';
import { fmtCost, fmtTokens, fmtDuration } from '../lib/format';
import { Avatar, relTime } from './ui';

const TRIGGER_LABEL: Record<string, string> = {
  mention: '@mention', dm: 'DM', task: 'task', schedule: 'schedule', hook: 'trigger', agent: 'hand-off', manual: 'manual',
};

export default function ActivityPanel() {
  const { activeServer } = useServer();
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'error'>('all');

  useEffect(() => {
    if (!activeServer) return;
    setLoading(true);
    activityApi.list(activeServer.id, filter === 'error' ? { status: 'error' } : undefined)
      .then(({ runs }) => setRuns(runs))
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [activeServer, filter]);

  // Live: prepend finished runs.
  useEffect(() => {
    return onSocketEvent('run:finished', (data: unknown) => {
      const { run } = data as { run: ActivityRun };
      if (filter === 'error' && run.status !== 'error') return;
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].slice(0, 200));
    });
  }, [filter]);

  const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-lg font-semibold text-cream-50">Activity</h1>
          <span className="text-xs text-ink-500">{runs.length} runs · {fmtCost(totalCost)}</span>
          <div className="ml-auto inline-flex rounded-lg bg-ink-800 border border-ink-700 p-0.5 text-xs">
            <button onClick={() => setFilter('all')} className={clsx('px-3 py-1 rounded-md transition-colors', filter === 'all' ? 'bg-ink-700 text-cream-50' : 'text-cream-400')}>All</button>
            <button onClick={() => setFilter('error')} className={clsx('px-3 py-1 rounded-md transition-colors', filter === 'error' ? 'bg-ink-700 text-cream-50' : 'text-cream-400')}>Errors</button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-ink-500 py-8 text-center animate-pulse">Loading…</p>
        ) : runs.length === 0 ? (
          <div className="text-center py-16 text-ink-500">
            <div className="text-4xl mb-2">📡</div>
            <p className="text-cream-300">No activity yet</p>
            <p className="text-sm">Agent runs will stream here as they happen.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {runs.map((r) => {
              const isOpen = expanded === r.id;
              const totalTokens = r.inputTokens + r.outputTokens;
              return (
                <div key={r.id} className={clsx('rounded-xl border transition-colors', isOpen ? 'border-ink-600 bg-ink-800' : 'border-ink-800 bg-ink-850 hover:border-ink-700')}>
                  <button onClick={() => setExpanded(isOpen ? null : r.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
                    <span className={clsx('w-2 h-2 rounded-full shrink-0', r.status === 'ok' ? 'bg-emerald-400' : r.status === 'error' ? 'bg-red-400' : 'bg-amber-400')} />
                    <Avatar name={r.agentName} size={22} />
                    <span className="text-sm text-cream-100 font-medium shrink-0">{r.agentName}</span>
                    <span className="text-[10px] uppercase tracking-wide text-ink-500 bg-ink-800 border border-ink-700 rounded px-1.5 py-0.5 shrink-0">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
                    <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
                      {r.tools.slice(0, 4).map((t) => (
                        <span key={t} className="text-[10px] text-cream-400 bg-ink-800 rounded px-1.5 py-0.5 truncate">{t}</span>
                      ))}
                      {r.tools.length > 4 && <span className="text-[10px] text-ink-500">+{r.tools.length - 4}</span>}
                    </div>
                    <span className="text-xs text-ink-500 shrink-0 tabular-nums hidden sm:inline">{fmtTokens(totalTokens)} tok</span>
                    <span className="text-xs text-ink-500 shrink-0 tabular-nums">{fmtDuration(r.durationMs)}</span>
                    <span className="text-xs text-clay/80 shrink-0 tabular-nums w-14 text-right">{fmtCost(r.costUsd)}</span>
                    <span className="text-xs text-ink-600 shrink-0 w-14 text-right hidden md:inline">{relTime(r.createdAt)}</span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pt-1 border-t border-ink-700/60 text-xs text-cream-400 space-y-1.5">
                      {r.error && <div className="text-red-400 bg-red-500/10 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap">{r.error}</div>}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                        <Stat label="Model" value={r.model || '—'} />
                        <Stat label="Input" value={`${fmtTokens(r.inputTokens)} tok`} />
                        <Stat label="Output" value={`${fmtTokens(r.outputTokens)} tok`} />
                        <Stat label="Cache read" value={fmtTokens(r.cacheReadTokens)} />
                      </div>
                      {r.tools.length > 0 && (
                        <div className="pt-1">
                          <span className="text-ink-500">Tools: </span>
                          {r.tools.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-600">{label}</div>
      <div className="text-cream-200">{value}</div>
    </div>
  );
}
