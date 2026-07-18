import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { questions as questionsApi } from '../lib/api';
import { onSocketEvent } from '../lib/socket';
import type { AgentQuestion } from '../lib/types';

// An interactive question the agent asked: multiple-choice buttons or a free-text
// box. Answering posts back and resumes the asking agent.
export default function QuestionCard({ questionId }: { questionId: string }) {
  const { activeServer } = useServer();
  const { addToast } = useNotifications();
  const [q, setQ] = useState<AgentQuestion | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeServer) return;
    let live = true;
    questionsApi.get(activeServer.id, questionId).then(({ question }) => live && setQ(question)).catch(() => {});
    // Live update if answered elsewhere (e.g. another window).
    const off = onSocketEvent('question:updated', (data: unknown) => {
      const nq = (data as { question?: AgentQuestion }).question;
      if (nq && nq.id === questionId) setQ(nq);
    });
    return () => { live = false; off(); };
  }, [activeServer, questionId]);

  if (!q) return <div className="mt-1 text-xs text-ink-500">❓ Loading question…</div>;

  const submit = async (answer: string) => {
    if (!activeServer || !answer.trim() || busy) return;
    setBusy(true);
    try {
      const { question } = await questionsApi.answer(activeServer.id, questionId, answer.trim());
      setQ(question);
    } catch (e) {
      addToast("Couldn't send answer", (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const answered = q.status === 'answered';

  return (
    <div className={clsx('mt-1.5 max-w-md rounded-xl bg-ink-800 border p-3', answered ? 'border-ink-700' : 'border-clay/40')}>
      <div className="flex items-start gap-2 mb-2.5">
        <span className="text-sm mt-0.5">❓</span>
        <span className="text-sm text-cream-100 flex-1">{q.prompt}</span>
      </div>

      {answered ? (
        <div className="text-xs text-ink-400">
          <span className="text-emerald-400">✓</span> Answered: <span className="text-cream-300">{q.answer}</span>
        </div>
      ) : q.kind === 'choice' ? (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((opt) => (
            <button key={opt} disabled={busy} onClick={() => submit(opt)}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-ink-750 border border-ink-600 text-cream-200 hover:border-clay hover:text-clay transition-colors disabled:opacity-50">
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-1.5">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(text); }}
            placeholder="Type your answer…"
            disabled={busy}
            className="flex-1 text-xs bg-ink-850 border border-ink-600 rounded-lg px-2.5 py-1.5 text-cream-100 focus:outline-none focus:border-clay disabled:opacity-50"
          />
          <button onClick={() => submit(text)} disabled={busy || !text.trim()}
            className="text-xs px-3 py-1.5 rounded-lg bg-clay text-white hover:bg-clay-400 transition-colors disabled:opacity-50">
            Send
          </button>
        </div>
      )}
    </div>
  );
}
