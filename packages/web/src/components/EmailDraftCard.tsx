import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { emailDrafts as draftsApi } from '../lib/api';
import { onSocketEvent } from '../lib/socket';
import type { EmailDraft } from '../lib/types';

// An email the agent wants to send, held for review: preview the envelope, edit
// it inline, ask the agent to rewrite it, or send. Nothing hits SMTP until Send.
export default function EmailDraftCard({ draftId }: { draftId: string }) {
  const { activeServer } = useServer();
  const { addToast } = useNotifications();
  const [d, setD] = useState<EmailDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ to: '', cc: '', subject: '', body: '' });
  const [instruction, setInstruction] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeServer) return;
    let live = true;
    draftsApi.get(activeServer.id, draftId).then(({ draft: x }) => live && setD(x)).catch(() => {});
    const off = onSocketEvent('emaildraft:updated', (data: unknown) => {
      const nd = (data as { draft?: EmailDraft }).draft;
      if (nd && nd.id === draftId) setD(nd);
    });
    return () => { live = false; off(); };
  }, [activeServer, draftId]);

  if (!d) return <div className="mt-1 text-xs text-ink-500">✉️ Loading draft…</div>;

  const run = async (fn: () => Promise<{ draft: EmailDraft }>, errLabel: string) => {
    if (!activeServer || busy) return;
    setBusy(true);
    try {
      const { draft: x } = await fn();
      setD(x);
      setEditing(false);
      setAsking(false);
    } catch (e) {
      addToast(errLabel, (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    setDraft({ to: d.to, cc: d.cc ?? '', subject: d.subject, body: d.body });
    setEditing(true);
  };
  const save = () => run(() => draftsApi.patch(activeServer!.id, draftId, { ...draft, cc: draft.cc || null }), "Couldn't save");
  const send = () => run(() => draftsApi.send(activeServer!.id, draftId), 'Send failed');
  const discard = () => run(() => draftsApi.discard(activeServer!.id, draftId), "Couldn't discard");
  const revise = () => {
    if (!instruction.trim()) return;
    run(() => draftsApi.revise(activeServer!.id, draftId, instruction.trim()), "Couldn't send request");
  };

  const field = 'w-full text-xs bg-ink-850 border border-ink-600 rounded-lg px-2.5 py-1.5 text-cream-100 focus:outline-none focus:border-clay disabled:opacity-50';
  const chip = 'text-xs px-2.5 py-1.5 rounded-lg bg-ink-750 border border-ink-600 text-cream-200 hover:border-clay hover:text-clay transition-colors disabled:opacity-50';

  if (d.status === 'sent') {
    return (
      <div className="mt-1.5 max-w-lg rounded-xl bg-ink-800 border border-ink-700 p-3 text-xs">
        <span className="text-emerald-400">✓</span> Sent to <span className="text-cream-300">{d.to}</span> — “{d.subject}”
      </div>
    );
  }
  if (d.status === 'discarded') {
    return <div className="mt-1.5 max-w-lg rounded-xl bg-ink-800 border border-ink-700 p-3 text-xs text-ink-500">Draft discarded — “{d.subject}”</div>;
  }

  return (
    <div className={clsx('mt-1.5 max-w-lg rounded-xl bg-ink-800 border border-clay/40 p-3')}>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-sm">✉️</span>
        <span className="text-xs text-ink-400">Draft — nothing is sent until you press Send</span>
      </div>

      {editing ? (
        <div className="space-y-1.5">
          <input className={field} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} placeholder="To" />
          <input className={field} value={draft.cc} onChange={(e) => setDraft({ ...draft, cc: e.target.value })} placeholder="Cc (optional)" />
          <input className={field} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Subject" />
          <textarea className={clsx(field, 'min-h-[140px] font-sans leading-relaxed resize-y')} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <div className="flex gap-1.5 pt-0.5">
            <button onClick={save} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-clay text-white hover:bg-clay-400 transition-colors disabled:opacity-50">Save</button>
            <button onClick={() => setEditing(false)} disabled={busy} className={chip}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <dl className="text-xs space-y-1 mb-2.5">
            <div className="flex gap-2"><dt className="w-14 shrink-0 text-ink-500">From</dt><dd className="text-cream-300">{d.fromAddr ?? <span className="text-amber-400">no mailbox connected</span>}</dd></div>
            <div className="flex gap-2"><dt className="w-14 shrink-0 text-ink-500">To</dt><dd className="text-cream-300">{d.to}</dd></div>
            {d.cc && <div className="flex gap-2"><dt className="w-14 shrink-0 text-ink-500">Cc</dt><dd className="text-cream-300">{d.cc}</dd></div>}
            <div className="flex gap-2"><dt className="w-14 shrink-0 text-ink-500">Subject</dt><dd className="text-cream-100">{d.subject}</dd></div>
          </dl>
          <div className="text-xs text-cream-200 whitespace-pre-wrap leading-relaxed border-t border-ink-700 pt-2.5 mb-2.5 max-h-72 overflow-y-auto">{d.body}</div>

          <div className="flex flex-wrap gap-1.5">
            <button onClick={send} disabled={busy || !d.fromAddr} title={d.fromAddr ? undefined : 'Connect a mailbox in Settings → Email'}
              className="text-xs px-3 py-1.5 rounded-lg bg-clay text-white hover:bg-clay-400 transition-colors disabled:opacity-50">
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button onClick={startEdit} disabled={busy} className={chip}>Edit</button>
            <button onClick={() => setAsking((v) => !v)} disabled={busy} className={chip}>Ask for changes</button>
            <button onClick={discard} disabled={busy} className="text-xs px-2.5 py-1.5 rounded-lg text-ink-500 hover:text-red-400 transition-colors disabled:opacity-50">Discard</button>
          </div>

          {asking && (
            <div className="flex gap-1.5 mt-2">
              <input
                autoFocus
                className={field}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') revise(); }}
                placeholder="e.g. make it shorter and less formal"
                disabled={busy}
              />
              <button onClick={revise} disabled={busy || !instruction.trim()}
                className="text-xs px-3 py-1.5 rounded-lg bg-clay text-white hover:bg-clay-400 transition-colors disabled:opacity-50 shrink-0">
                Rewrite
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
