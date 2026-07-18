import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { agents as agentsApi } from '../lib/api';
import type { Agent, ModelClass, Effort } from '../lib/types';
import { Avatar, StatusDot, Button, Modal } from './ui';

const MODELS: ModelClass[] = ['HAIKU', 'SONNET', 'OPUS'];
const EFFORTS: Effort[] = ['LOW', 'MEDIUM', 'HIGH'];
const STATUS_LABEL: Record<Agent['status'], string> = {
  IDLE: 'Idle', THINKING: 'Thinking', WORKING: 'Working', ERROR: 'Error', PAUSED: 'Paused',
};

export default function AgentProfile({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { activeServer, refreshAgents } = useServer();
  const { addToast } = useNotifications();

  const patch = async (body: Partial<Agent>, note?: string) => {
    if (!activeServer) return;
    try {
      await agentsApi.patch(activeServer.id, agent.id, body);
      await refreshAgents();
      if (note) addToast(note, undefined, 'success');
    } catch (e) {
      addToast('Update failed', (e as Error).message, 'error');
    }
  };

  const togglePause = async () => {
    if (!activeServer) return;
    try {
      if (agent.status === 'PAUSED' || !agent.enabled) await agentsApi.resume(activeServer.id, agent.id);
      else await agentsApi.pause(activeServer.id, agent.id);
      await refreshAgents();
    } catch (e) {
      addToast('Failed', (e as Error).message, 'error');
    }
  };

  const paused = agent.status === 'PAUSED' || !agent.enabled;
  const tools = agent.enabledTools ?? [];

  return (
    <Modal open onClose={onClose} title="Agent profile">
      <div className="flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="relative">
            <Avatar name={agent.name} url={agent.avatarUrl} size={64} ring={agent.isManager ? 'ring-2 ring-clay' : undefined} />
            <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-ink-850">
              <StatusDot status={agent.status} size={13} />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className={clsx('text-lg font-semibold truncate', agent.isManager ? 'text-clay' : 'text-cream-50')}>{agent.name}</h3>
              {agent.isManager && <span className="text-[10px] uppercase tracking-wide bg-clay/20 text-clay px-1.5 py-0.5 rounded">Manager</span>}
            </div>
            <div className="text-sm text-cream-400 flex items-center gap-1.5 mt-0.5">
              <StatusDot status={agent.status} /> {STATUS_LABEL[agent.status]}
              {agent.thinkingLine && <span className="text-ink-500 truncate">· {agent.thinkingLine}</span>}
            </div>
            {agent.statusText && <div className="text-sm text-cream-300 mt-1 italic">“{agent.statusText}”</div>}
          </div>
        </div>

        {agent.bio && <p className="text-sm text-cream-300">{agent.bio}</p>}

        {/* Persona */}
        <Field label="Persona">
          <p className="text-sm text-cream-300 whitespace-pre-wrap max-h-32 overflow-y-auto bg-ink-800 rounded-lg p-3 border border-ink-700">{agent.systemPrompt}</p>
        </Field>

        {/* Model + effort quick-swap (changeable anytime) */}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Model">
            <div className="flex gap-1">
              {MODELS.map((m) => (
                <button key={m} onClick={() => patch({ modelClass: m }, `${agent.name} → ${m.toLowerCase()}`)}
                  className={clsx('flex-1 py-1.5 rounded-lg text-xs transition-colors', agent.modelClass === m ? 'bg-clay text-white' : 'bg-ink-800 text-cream-300 hover:bg-ink-700')}>
                  {m.toLowerCase()}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Effort">
            <div className="flex gap-1">
              {EFFORTS.map((ef) => (
                <button key={ef} onClick={() => patch({ effort: ef }, `${agent.name} effort → ${ef.toLowerCase()}`)}
                  className={clsx('flex-1 py-1.5 rounded-lg text-xs transition-colors', agent.effort === ef ? 'bg-clay text-white' : 'bg-ink-800 text-cream-300 hover:bg-ink-700')}>
                  {ef.toLowerCase()}
                </button>
              ))}
            </div>
          </Field>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Meta label="Personality" value={agent.personality < 33 ? 'Professional' : agent.personality < 66 ? 'Balanced' : 'Personable'} />
          <Meta label="Memory" value={agent.memoryScope ?? 'both'} />
          <Meta label="Approval" value={agent.requiresApproval ? 'Required' : 'Off'} />
        </div>

        {/* Tools */}
        <Field label={`Tools · ${tools.length}`}>
          {tools.length === 0 ? (
            <p className="text-xs text-ink-500">No tools enabled.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tools.map((t) => (
                <span key={t} className="text-xs font-mono bg-ink-800 border border-ink-700 rounded px-2 py-0.5 text-cream-300">{t}</span>
              ))}
            </div>
          )}
        </Field>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-ink-700">
          <Button variant="ghost" onClick={togglePause}>{paused ? '▶ Resume' : '⏸ Pause'}</Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-cream-400 mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-800 rounded-lg p-2.5 border border-ink-700">
      <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-cream-100 text-sm mt-0.5 capitalize truncate">{value}</div>
    </div>
  );
}
