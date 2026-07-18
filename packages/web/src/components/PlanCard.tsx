import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { plans as plansApi } from '../lib/api';
import { onSocketEvent } from '../lib/socket';
import type { Plan, PlanStep } from '../lib/types';

// A live, watchable plan the Manager created: goal + ordered steps whose
// statuses update in real time as the agent works through them.
export default function PlanCard({ planId }: { planId: string }) {
  const { activeServer } = useServer();
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    if (!activeServer) return;
    let live = true;
    plansApi.get(activeServer.id, planId).then(({ plan }) => live && setPlan(plan)).catch(() => {});
    // Live updates: the Manager marks steps running → done as it executes.
    const off = onSocketEvent('plan:updated', (data: unknown) => {
      const p = (data as { plan?: Plan }).plan;
      if (p && p.id === planId) setPlan(p);
    });
    return () => { live = false; off(); };
  }, [activeServer, planId]);

  if (!plan) {
    return <div className="mt-1 text-xs text-ink-500">📋 Loading plan…</div>;
  }

  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const pct = plan.steps.length ? Math.round((done / plan.steps.length) * 100) : 0;
  const statusTint =
    plan.status === 'done' ? 'border-emerald-500/40' :
    plan.status === 'failed' ? 'border-red-500/40' : 'border-clay/40';

  return (
    <div className={clsx('mt-1.5 max-w-lg rounded-xl bg-ink-800 border p-3', statusTint)}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm">📋</span>
        <span className="text-sm font-medium text-cream-100 flex-1 min-w-0 truncate">{plan.goal}</span>
        <span className={clsx('text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-semibold',
          plan.status === 'done' ? 'bg-emerald-600/20 text-emerald-300' :
          plan.status === 'failed' ? 'bg-red-600/20 text-red-300' : 'bg-clay/20 text-clay')}>
          {plan.status === 'active' ? `${done}/${plan.steps.length}` : plan.status}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-full bg-ink-700 mb-2.5 overflow-hidden">
        <div className={clsx('h-full rounded-full transition-all duration-500',
          plan.status === 'failed' ? 'bg-red-400' : 'bg-clay')} style={{ width: `${pct}%` }} />
      </div>

      <ol className="space-y-1.5">
        {plan.steps.map((s) => <StepRow key={s.id} step={s} />)}
      </ol>
    </div>
  );
}

function StepRow({ step }: { step: PlanStep }) {
  const icon =
    step.status === 'done' ? <span className="text-emerald-400">✓</span> :
    step.status === 'failed' ? <span className="text-red-400">✕</span> :
    step.status === 'skipped' ? <span className="text-ink-500">–</span> :
    step.status === 'running' ? <span className="inline-block w-3 h-3 rounded-full border-2 border-clay border-t-transparent animate-spin" /> :
    <span className="inline-block w-3 h-3 rounded-full border border-ink-500" />;

  return (
    <li className="flex items-start gap-2.5 text-xs">
      <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0 mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className={clsx('text-cream-200',
          step.status === 'done' && 'text-ink-400 line-through',
          step.status === 'skipped' && 'text-ink-500 line-through')}>
          {step.title}
        </span>
        {step.agentName && <span className="ml-1.5 text-[10px] text-ink-500">· {step.agentName}</span>}
        {step.result && <span className="block text-[11px] text-ink-500 leading-snug mt-0.5">{step.result}</span>}
      </span>
    </li>
  );
}
