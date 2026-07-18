import { useState } from 'react';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { tasks as tasksApi } from '../lib/api';
import type { TaskStatus } from '../lib/types';
import { Avatar, Button, Input } from './ui';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'QUEUED', label: 'Queued' },
  { status: 'IN_PROGRESS', label: 'In progress' },
  { status: 'REVIEW', label: 'Review' },
  { status: 'DONE', label: 'Done' },
  { status: 'FAILED', label: 'Failed' },
];

export default function TaskPanel() {
  const { activeServer, tasks, agents, refreshTasks } = useServer();
  const { addToast } = useNotifications();
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');

  const create = async () => {
    if (!activeServer || !title.trim()) return;
    try {
      await tasksApi.create(activeServer.id, {
        title: title.trim(),
        assignedAgentId: assignee || undefined,
        mode: assignee ? 'manual' : 'managed',
      });
      setTitle('');
      setAssignee('');
      await refreshTasks();
      addToast('Task created', undefined, 'success');
    } catch (e) {
      addToast('Failed', (e as Error).message, 'error');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6">
      {/* Composer */}
      <div className="flex gap-2 mb-5">
        <Input placeholder="Drop a task… the Manager will assign it" value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
          className="bg-ink-800 text-cream-100 rounded-lg px-3 text-sm border border-ink-700 focus:outline-none focus:border-clay">
          <option value="">Manager assigns</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <Button onClick={create}>Add</Button>
      </div>

      {/* Board */}
      <div className="flex-1 grid grid-cols-5 gap-3 min-h-0">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <div key={col.status} className="flex flex-col bg-ink-800/50 rounded-xl border border-ink-700/50 min-h-0">
              <div className="px-3 py-2 text-xs uppercase tracking-wide text-ink-400 font-semibold border-b border-ink-700/50 flex justify-between">
                {col.label} <span className="text-ink-600">{items.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {items.map((t) => {
                  const agent = agents.find((a) => a.id === t.assignedAgentId);
                  return (
                    <div key={t.id} className="bg-ink-800 rounded-lg p-3 border border-ink-700 animate-fade-in">
                      <div className="text-sm text-cream-100 font-medium">{t.title}</div>
                      {t.description && <div className="text-xs text-cream-400 mt-1 line-clamp-2">{t.description}</div>}
                      {t.result && <div className="text-xs text-emerald-300/80 mt-1 line-clamp-2">{t.result}</div>}
                      <div className="flex items-center gap-2 mt-2">
                        {agent ? (
                          <><Avatar name={agent.name} url={agent.avatarUrl} size={20} /><span className="text-xs text-ink-400">{agent.name}</span></>
                        ) : (
                          <span className="text-xs text-ink-500">unassigned</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
