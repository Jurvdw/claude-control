import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { hooks as hooksApi } from '../lib/api';
import type { Hook } from '../lib/types';
import { Button, Input } from './ui';

type TriggerType = 'keyword' | 'new_file' | 'webhook';
const TRIGGER_META: Record<TriggerType, { icon: string; label: string; desc: string }> = {
  keyword: { icon: '🔑', label: 'Keyword', desc: 'When a message contains a word/phrase' },
  new_file: { icon: '📎', label: 'File uploaded', desc: 'When a file is attached in a channel' },
  webhook: { icon: '🌐', label: 'Webhook', desc: 'When an external service POSTs to your URL' },
};

const BLANK = { name: '', trigger: 'keyword' as TriggerType, keyword: '', agentId: '', channelId: '', promptTemplate: '', enabled: true };

export default function TriggersPanel() {
  const { activeServer, agents, channels } = useServer();
  const { addToast } = useNotifications();
  const [list, setList] = useState<Hook[]>([]);
  const [draft, setDraft] = useState<typeof BLANK | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');

  const refresh = () => {
    if (!activeServer) return;
    hooksApi.list(activeServer.id).then(({ hooks }) => setList(hooks)).catch(() => {});
  };
  useEffect(refresh, [activeServer]);

  const startNew = () => setDraft({ ...BLANK, agentId: agents[0]?.id ?? '' });

  const save = async () => {
    if (!activeServer || !draft) return;
    if (!draft.name.trim() || !draft.agentId || !draft.promptTemplate.trim()) {
      addToast('Missing fields', 'Name, agent, and instruction are required.', 'error');
      return;
    }
    try {
      await hooksApi.create(activeServer.id, {
        name: draft.name.trim(),
        trigger: draft.trigger,
        config: draft.trigger === 'keyword' ? { keyword: draft.keyword.trim() } : {},
        agentId: draft.agentId,
        channelId: draft.channelId || undefined,
        promptTemplate: draft.promptTemplate.trim(),
        enabled: draft.enabled,
      });
      setDraft(null);
      refresh();
      addToast('Trigger created', draft.name, 'success');
    } catch (e) {
      addToast('Failed', (e as Error).message, 'error');
    }
  };

  const toggle = async (h: Hook) => {
    if (!activeServer) return;
    await hooksApi.patch(activeServer.id, h.id, { enabled: !h.enabled }).catch(() => {});
    refresh();
  };
  const remove = async (h: Hook) => {
    if (!activeServer) return;
    await hooksApi.delete(activeServer.id, h.id).catch(() => {});
    refresh();
  };
  const showWebhookUrl = async () => {
    if (!activeServer) return;
    const { url } = await hooksApi.webhookUrl(activeServer.id);
    setWebhookUrl(url);
  };

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? 'Agent';
  const channelName = (id?: string) => channels.find((c) => c.id === id)?.name;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-lg font-semibold text-cream-50">Triggers</h1>
          <span className="text-xs text-ink-500">agents that act on their own</span>
          <button onClick={startNew} className="ml-auto text-sm px-3 py-1.5 rounded-lg bg-clay text-white hover:bg-clay-400 transition-colors">+ New trigger</button>
        </div>
        <p className="text-sm text-ink-500 mb-5">When something happens — a keyword is said, a file is dropped, or an external webhook fires — an agent runs automatically.</p>

        {/* Create form */}
        {draft && (
          <div className="bg-ink-850 border border-ink-700 rounded-2xl p-5 mb-5 space-y-3 animate-fade-in">
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="Trigger name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <select value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as TriggerType })}
                className="bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm border border-ink-700 focus:outline-none focus:border-clay">
                {(Object.keys(TRIGGER_META) as TriggerType[]).map((t) => <option key={t} value={t}>{TRIGGER_META[t].icon} {TRIGGER_META[t].label}</option>)}
              </select>
            </div>
            <p className="text-xs text-ink-500">{TRIGGER_META[draft.trigger].desc}</p>

            {draft.trigger === 'keyword' && (
              <Input placeholder="Keyword or phrase (e.g. urgent)" value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} />
            )}
            {draft.trigger === 'webhook' && (
              <div className="text-xs text-cream-400 bg-ink-800 rounded-lg p-3">
                {webhookUrl
                  ? <>POST to this URL to fire: <code className="text-clay break-all">{webhookUrl}</code></>
                  : <button onClick={showWebhookUrl} className="text-clay hover:underline">Reveal this workspace's webhook URL</button>}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-ink-500 block mb-1">Run this agent</label>
                <select value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
                  className="w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm border border-ink-700 focus:outline-none focus:border-clay">
                  <option value="">— pick —</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-ink-500 block mb-1">In channel (optional)</label>
                <select value={draft.channelId} onChange={(e) => setDraft({ ...draft, channelId: e.target.value })}
                  className="w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm border border-ink-700 focus:outline-none focus:border-clay">
                  <option value="">Any channel</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-ink-500 block mb-1">Instruction for the agent</label>
              <textarea rows={3} value={draft.promptTemplate} onChange={(e) => setDraft({ ...draft, promptTemplate: e.target.value })}
                placeholder="What should the agent do? Use {{message}} to reference the triggering message."
                className="w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm border border-ink-700 focus:outline-none focus:border-clay resize-none" />
            </div>
            <div className="flex gap-2">
              <Button onClick={save}>Create trigger</Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </div>
        )}

        {/* List */}
        {list.length === 0 && !draft ? (
          <div className="text-center py-16 text-ink-500">
            <div className="text-4xl mb-2">⚡</div>
            <p className="text-cream-300">No triggers yet</p>
            <p className="text-sm">Create one so an agent reacts automatically.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {list.map((h) => {
              const m = TRIGGER_META[h.trigger];
              const kw = (h.config as { keyword?: string })?.keyword;
              return (
                <div key={h.id} className="flex items-center gap-3 bg-ink-850 border border-ink-800 rounded-xl px-4 py-3">
                  <span className="text-lg">{m.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-cream-100 font-medium truncate">{h.name}</div>
                    <div className="text-xs text-ink-500 truncate">
                      {m.label}{kw ? ` "${kw}"` : ''}{channelName(h.channelId) ? ` in #${channelName(h.channelId)}` : ''} → <span className="text-cream-400">@{agentName(h.agentId)}</span>
                    </div>
                  </div>
                  <button onClick={() => toggle(h)} role="switch" aria-checked={h.enabled}
                    className={clsx('relative w-10 h-5 rounded-full transition-colors shrink-0', h.enabled ? 'bg-clay' : 'bg-ink-700')}>
                    <span className={clsx('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', h.enabled && 'translate-x-5')} />
                  </button>
                  <button onClick={() => remove(h)} className="text-ink-500 hover:text-red-400 text-sm shrink-0">🗑</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
