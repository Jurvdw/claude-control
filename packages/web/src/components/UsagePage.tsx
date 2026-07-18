import { useEffect, useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { useServer } from '../state/ServerContext';
import { usage as usageApi } from '../lib/api';
import { fmtCost } from '../lib/format';
import type { UsageData } from '../lib/types';

const CLAY = '#d97757';
const BARS = ['#d97757', '#e08a6d', '#b8b2a4', '#5a544a', '#c25f3f'];

export default function UsagePage() {
  const { activeServer } = useServer();
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeServer) return;
    setLoading(true);
    usageApi.server(activeServer.id)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [activeServer]);

  if (loading) return <div className="flex-1 flex items-center justify-center text-ink-500">Crunching usage…</div>;
  if (!data) return <div className="flex-1 flex items-center justify-center text-ink-500">No usage data yet.</div>;


  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card label="Total cost" value={fmtCost(data.totalCost)} />
        <Card label="Total runs" value={String(data.totalRuns)} />
        <Card label="Avg / run" value={data.totalRuns ? fmtCost(data.totalCost / data.totalRuns) : '$0'} />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Panel title="Cost over time">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data.costOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="#332f28" />
              <XAxis dataKey="date" stroke="#5a544a" fontSize={11} />
              <YAxis stroke="#5a544a" fontSize={11} />
              <Tooltip contentStyle={tooltip} formatter={(v: number) => fmtCost(v)} />
              <Line type="monotone" dataKey="cost" stroke={CLAY} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Cost per agent">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.perAgent}>
              <CartesianGrid strokeDasharray="3 3" stroke="#332f28" />
              <XAxis dataKey="agentName" stroke="#5a544a" fontSize={11} />
              <YAxis stroke="#5a544a" fontSize={11} />
              <Tooltip contentStyle={tooltip} formatter={(v: number) => fmtCost(v)} />
              <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                {data.perAgent.map((_, i) => <Cell key={i} fill={BARS[i % BARS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Tokens by model">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.tokensByModel}>
              <CartesianGrid strokeDasharray="3 3" stroke="#332f28" />
              <XAxis dataKey="model" stroke="#5a544a" fontSize={11} />
              <YAxis stroke="#5a544a" fontSize={11} />
              <Tooltip contentStyle={tooltip} />
              <Bar dataKey="input" stackId="a" fill="#5a544a" radius={[0, 0, 0, 0]} />
              <Bar dataKey="output" stackId="a" fill={CLAY} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Top expensive tasks">
          <div className="space-y-2">
            {data.topTasks.length === 0 && <p className="text-sm text-ink-500">No tasks yet.</p>}
            {data.topTasks.map((t) => (
              <div key={t.taskId} className="flex justify-between text-sm border-b border-ink-700/50 pb-1.5">
                <span className="text-cream-200 truncate mr-2">{t.title}</span>
                <span className="text-clay font-mono shrink-0">{fmtCost(t.cost)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

const tooltip = { background: '#211f1a', border: '1px solid #413c33', borderRadius: 8, color: '#f3f1ea', fontSize: 12 };

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-800 border border-ink-700 rounded-xl p-4">
      <div className="text-xs text-ink-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-cream-50 mt-1">{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-ink-800 border border-ink-700 rounded-xl p-4">
      <div className="text-sm font-medium text-cream-200 mb-3">{title}</div>
      {children}
    </div>
  );
}
