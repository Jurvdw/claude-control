import React from 'react';
import clsx from 'clsx';
import type { AgentStatus } from '../lib/types';

// ─── Shared UI primitives ────────────────────────────────────────────────────

export function Avatar({ url, name, size = 36, ring }: { url?: string; name: string; size?: number; ring?: string }) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      className={clsx('rounded-xl overflow-hidden shrink-0 flex items-center justify-center bg-ink-700 text-cream-200 text-xs font-semibold', ring)}
      style={{ width: size, height: size }}
    >
      {url ? <img src={url} alt={name} className="w-full h-full object-cover" /> : initials}
    </div>
  );
}

const STATUS_META: Record<AgentStatus, { color: string; label: string; pulse: boolean }> = {
  IDLE: { color: 'bg-emerald-400', label: 'idle', pulse: false },
  THINKING: { color: 'bg-amber-400', label: 'thinking', pulse: true },
  WORKING: { color: 'bg-sky-400', label: 'working', pulse: true },
  ERROR: { color: 'bg-red-500', label: 'error', pulse: false },
  PAUSED: { color: 'bg-ink-500', label: 'paused', pulse: false },
};

export function StatusDot({ status, size = 10 }: { status: AgentStatus; size?: number }) {
  const m = STATUS_META[status];
  return (
    <span
      className={clsx('inline-block rounded-full', m.color, m.pulse && 'animate-pulse-dot')}
      style={{ width: size, height: size }}
      title={m.label}
    />
  );
}

export function Button({
  children,
  variant = 'primary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  return (
    <button
      {...props}
      className={clsx(
        'px-4 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-clay/60 disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'primary' && 'bg-clay hover:bg-clay-600 text-white',
        variant === 'ghost' && 'bg-ink-750 hover:bg-ink-600 text-cream-100',
        variant === 'danger' && 'bg-red-600/90 hover:bg-red-600 text-white',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        'w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm border border-ink-700 placeholder:text-ink-500 focus:outline-none focus:border-clay transition-colors',
        props.className,
      )}
    />
  );
}

export function Modal({ open, onClose, children, title, wide }: { open: boolean; onClose: () => void; children: React.ReactNode; title: string; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={clsx('bg-ink-850 border border-ink-700 rounded-2xl shadow-2xl w-full flex flex-col max-h-[88vh]', wide ? 'max-w-2xl' : 'max-w-md')}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-700">
          <h2 className="text-lg font-semibold text-cream-50">{title}</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-cream-100 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function relTime(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
