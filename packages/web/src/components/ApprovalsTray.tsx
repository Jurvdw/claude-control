import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { approvals as approvalsApi } from '../lib/api';
import { Button, relTime } from './ui';

export default function ApprovalsTray({ onClose }: { onClose: () => void }) {
  const { activeServer, approvals, refreshApprovals } = useServer();
  const { addToast } = useNotifications();
  const pending = approvals.filter((a) => a.status === 'PENDING');

  const decide = async (id: string, ok: boolean) => {
    if (!activeServer) return;
    try {
      if (ok) await approvalsApi.approve(activeServer.id, id);
      else await approvalsApi.reject(activeServer.id, id);
      await refreshApprovals();
      addToast(ok ? 'Approved & executed' : 'Rejected', undefined, ok ? 'success' : 'info');
    } catch (e) {
      addToast('Failed', (e as Error).message, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 animate-fade-in" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-[420px] max-w-full h-full bg-ink-850 border-l border-ink-700 flex flex-col animate-slide-in">
        <div className="h-14 flex items-center justify-between px-5 border-b border-ink-700">
          <h2 className="font-semibold text-cream-50">🛡 Approvals</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-cream-100 text-xl">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {pending.length === 0 && (
            <div className="text-center text-ink-500 pt-16">
              <div className="text-3xl mb-2">✅</div>
              <p className="text-cream-300">Nothing awaiting approval.</p>
              <p className="text-sm">Gated actions (email, code, spend) will appear here.</p>
            </div>
          )}
          {pending.map((a) => {
            const p = a.payload as { input?: Record<string, unknown> } | undefined;
            const input = p?.input as Record<string, unknown> | undefined;
            const isEmail = a.action === 'send_email';
            return (
              <div key={a.id} className="bg-ink-800 border border-ink-700 rounded-xl p-4 animate-fade-in">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-clay font-semibold">{a.action}</span>
                  <span className="text-xs text-ink-500">{relTime(a.createdAt)}</span>
                </div>
                <p className="text-sm text-cream-100 mt-1">{a.summary}</p>
                {isEmail && input && (
                  <div className="mt-2 text-xs bg-ink-850 rounded-lg p-3 border border-ink-700 space-y-1">
                    <div><span className="text-ink-500">To:</span> {String(input.to ?? '')}</div>
                    <div><span className="text-ink-500">Subject:</span> {String(input.subject ?? '')}</div>
                    <div className="whitespace-pre-wrap text-cream-300 mt-1 border-t border-ink-700 pt-1">{String(input.body ?? '')}</div>
                  </div>
                )}
                {!isEmail && input && (
                  <pre className="mt-2 text-xs bg-ink-850 rounded-lg p-2 border border-ink-700 overflow-x-auto text-cream-400">{JSON.stringify(input, null, 2)}</pre>
                )}
                <div className="flex gap-2 mt-3">
                  <Button onClick={() => decide(a.id, true)}>Approve</Button>
                  <Button variant="ghost" onClick={() => decide(a.id, false)}>Reject</Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
