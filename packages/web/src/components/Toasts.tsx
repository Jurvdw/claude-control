import clsx from 'clsx';
import { useNotifications } from '../state/NotificationContext';

export default function Toasts() {
  const { toasts, dismissToast } = useNotifications();
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-80">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'animate-slide-in bg-ink-800 border rounded-xl px-4 py-3 shadow-xl cursor-pointer',
            t.kind === 'error' ? 'border-red-500/50' : t.kind === 'success' ? 'border-emerald-500/50' : 'border-ink-600',
          )}
          onClick={() => dismissToast(t.id)}
        >
          <div className="flex items-start gap-2">
            <span className={clsx('mt-1 w-2 h-2 rounded-full shrink-0', t.kind === 'error' ? 'bg-red-500' : t.kind === 'success' ? 'bg-emerald-400' : 'bg-clay')} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-cream-50 truncate">{t.title}</div>
              {t.body && <div className="text-xs text-cream-400 mt-0.5 line-clamp-2">{t.body}</div>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
