import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { agents as agentsApi } from '../lib/api';
import type { AgentTemplate, Tool, ModelClass, Effort } from '../lib/types';
import { Avatar, Button, Input, Modal } from './ui';

const MODELS: { v: ModelClass; label: string }[] = [
  { v: 'HAIKU', label: 'Haiku · fast & cheap' },
  { v: 'SONNET', label: 'Sonnet · balanced' },
  { v: 'OPUS', label: 'Opus · most capable' },
];
const EFFORTS: Effort[] = ['LOW', 'MEDIUM', 'HIGH'];

function dicebear(seed: string) {
  return `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(seed)}`;
}

export default function AgentCreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeServer, refreshAgents } = useServer();
  const { addToast } = useNotifications();
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);

  const [name, setName] = useState('');
  const [avatarSeed, setAvatarSeed] = useState(() => Math.random().toString(36).slice(2));
  const [avatarUrl, setAvatarUrl] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [bio, setBio] = useState('');
  const [modelClass, setModelClass] = useState<ModelClass>('SONNET');
  const [effort, setEffort] = useState<Effort>('MEDIUM');
  const [personality, setPersonality] = useState(30);
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [roleColor, setRoleColor] = useState('#d97757');
  const [proactive, setProactive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    agentsApi.templates().then(({ templates }) => setTemplates(templates)).catch(() => {});
    agentsApi.tools().then(({ tools }) => setTools(tools)).catch(() => {});
  }, []);

  const applyTemplate = (t: AgentTemplate) => {
    setName(t.name);
    setSystemPrompt(t.systemPrompt);
    setBio(t.description);
    setModelClass(t.modelClass);
    setEffort(t.effort);
    setEnabledTools(t.enabledTools);
    setIsManager(t.isManager);
    setAvatarSeed(t.name);
    if (t.isManager) setRoleColor('#d97757');
  };

  const toggleTool = (n: string) =>
    setEnabledTools((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));

  const create = async () => {
    if (!activeServer || !name.trim() || !systemPrompt.trim()) {
      addToast('Name and persona are required', undefined, 'error');
      return;
    }
    setBusy(true);
    try {
      await agentsApi.create(activeServer.id, {
        name: name.trim(),
        avatarUrl: avatarUrl.trim() || dicebear(avatarSeed),
        bio,
        systemPrompt,
        modelClass,
        effort,
        personality,
        enabledTools,
        isManager,
        requiresApproval,
        roleColor,
        proactivity: { proactive, taskDoneNotify: true } as never,
      });
      await refreshAgents();
      addToast('Agent created', name, 'success');
      onClose();
    } catch (e) {
      addToast('Failed to create agent', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const previewAvatar = avatarUrl.trim() || dicebear(avatarSeed);

  return (
    <Modal open={open} onClose={onClose} title="New agent" wide>
      <div className="flex flex-col gap-5">
        {/* Templates */}
        <div>
          <label className="text-xs text-cream-400 mb-2 block">Start from a template</label>
          <div className="flex gap-2 flex-wrap">
            {templates.map((t) => (
              <button key={t.id} onClick={() => applyTemplate(t)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ink-800 border border-ink-700 hover:border-clay text-sm text-cream-200 transition-colors">
                {t.name}
              </button>
            ))}
          </div>
        </div>

        {/* Identity */}
        <div className="flex gap-4 items-start">
          <div className="flex flex-col items-center gap-2">
            <Avatar name={name || '?'} url={previewAvatar} size={64} ring={isManager ? 'ring-2 ring-clay' : undefined} />
            <button onClick={() => { setAvatarSeed(Math.random().toString(36).slice(2)); setAvatarUrl(''); }}
              className="text-xs text-clay hover:text-clay-400">🎲 randomize</button>
          </div>
          <div className="flex-1 flex flex-col gap-3">
            <div>
              <label className="text-xs text-cream-400 mb-1 block">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Atlas" />
            </div>
            <div>
              <label className="text-xs text-cream-400 mb-1 block">Custom avatar URL (optional)</label>
              <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />
            </div>
          </div>
        </div>

        <div>
          <label className="text-xs text-cream-400 mb-1 block">Bio / status</label>
          <Input value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Short bio line" />
        </div>

        <div>
          <label className="text-xs text-cream-400 mb-1 block">Persona (system prompt)</label>
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4}
            placeholder="You are a meticulous researcher who…"
            className="w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm border border-ink-700 focus:outline-none focus:border-clay resize-none" />
        </div>

        {/* Model + effort */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-cream-400 mb-1 block">Model</label>
            <select value={modelClass} onChange={(e) => setModelClass(e.target.value as ModelClass)}
              className="w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm border border-ink-700 focus:outline-none focus:border-clay">
              {MODELS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-cream-400 mb-1 block">Effort</label>
            <div className="flex gap-1">
              {EFFORTS.map((e) => (
                <button key={e} onClick={() => setEffort(e)}
                  className={clsx('flex-1 py-2 rounded-lg text-xs transition-colors', effort === e ? 'bg-clay text-white' : 'bg-ink-800 text-cream-300 hover:bg-ink-700')}>
                  {e.toLowerCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Personality */}
        <div>
          <label className="text-xs text-cream-400 mb-1 flex justify-between">
            <span>Personality</span>
            <span className="text-ink-500">{personality < 33 ? 'professional' : personality < 66 ? 'balanced' : 'personable'}</span>
          </label>
          <input type="range" min={0} max={100} value={personality} onChange={(e) => setPersonality(Number(e.target.value))}
            className="w-full accent-clay" />
        </div>

        {/* Tools */}
        <div>
          <label className="text-xs text-cream-400 mb-2 block">Enabled tools</label>
          <div className="grid grid-cols-2 gap-1.5">
            {tools.map((t) => (
              <label key={t.name} className="flex items-center gap-2 text-sm text-cream-200 cursor-pointer px-2 py-1 rounded hover:bg-ink-800">
                <input type="checkbox" checked={enabledTools.includes(t.name)} onChange={() => toggleTool(t.name)} className="accent-clay" />
                <span className="font-mono text-xs">{t.name}</span>
                {t.requiresApproval && <span className="text-[10px] text-amber-400">approval</span>}
              </label>
            ))}
          </div>
        </div>

        {/* Toggles */}
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-cream-200 cursor-pointer">
            <input type="checkbox" checked={isManager} onChange={(e) => setIsManager(e.target.checked)} className="accent-clay" /> Manager
          </label>
          <label className="flex items-center gap-2 text-sm text-cream-200 cursor-pointer">
            <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} className="accent-clay" /> Require approval
          </label>
          <label className="flex items-center gap-2 text-sm text-cream-200 cursor-pointer">
            <input type="checkbox" checked={proactive} onChange={(e) => setProactive(e.target.checked)} className="accent-clay" /> Proactive
          </label>
          <label className="flex items-center gap-2 text-sm text-cream-200">
            Role color <input type="color" value={roleColor} onChange={(e) => setRoleColor(e.target.value)} className="w-7 h-7 rounded bg-transparent border-0 cursor-pointer" />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-ink-700">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create agent'}</Button>
        </div>
      </div>
    </Modal>
  );
}
