import { useState, useRef, useMemo, useEffect } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { messages as msgApi, tasks as tasksApi, brain as brainApi, agents as agentsApi, workflows as wfApi, channels as channelsApi, files as filesApi } from '../lib/api';
import type { View } from '../pages/AppPage';
import type { MessageFile } from '../lib/types';
import { speechInputAvailable, createRecognition } from '../lib/voice';
import { Avatar } from './ui';

const VOICE_INPUT = speechInputAvailable();

interface MentionItem {
  handle: string;
  label: string;
  avatarUrl?: string;
  isManager?: boolean;
  isEveryone?: boolean;
}

// Find an in-progress @mention at the caret (e.g. "hey @no|" → query "no").
function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const m = /(^|\s)@([\w-]*)$/.exec(upto);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

interface Props {
  onOpenAgentModal: () => void;
  onOpenView: (v: View) => void;
  onOpenSearch: (q: string) => void;
}

interface Command {
  cmd: string;
  arg: string;
  desc: string;
}

const COMMANDS: Command[] = [
  // Create / act
  { cmd: '/task', arg: '<description>', desc: 'Create a task (Manager assigns it)' },
  { cmd: '/automate', arg: '<description>', desc: 'Ask the Manager to build a workflow' },
  { cmd: '/run', arg: '<workflow>', desc: 'Run a workflow now, by name' },
  { cmd: '/note', arg: '<title>', desc: 'Create a Brain note' },
  { cmd: '/ask', arg: '@Agent <question>', desc: 'Ask a specific agent' },
  { cmd: '/summarize', arg: '', desc: 'Manager summarizes this channel into the Brain' },
  { cmd: '/channel', arg: '<name>', desc: 'Create a new channel' },
  // Navigate
  { cmd: '/search', arg: '<query>', desc: 'Search messages, notes, tasks, agents' },
  { cmd: '/brain', arg: '', desc: 'Open the Brain graph' },
  { cmd: '/tasks', arg: '', desc: 'Open tasks' },
  { cmd: '/workflows', arg: '', desc: 'Open the workflow builder' },
  { cmd: '/usage', arg: '', desc: 'Open the usage page' },
  { cmd: '/settings', arg: '', desc: 'Open settings' },
  { cmd: '/agent', arg: 'new', desc: 'Open the agent creator' },
  // Control
  { cmd: '/model', arg: '@Agent <haiku|sonnet|opus>', desc: 'Hot-swap an agent model' },
  { cmd: '/effort', arg: '@Agent <low|med|high>', desc: 'Change an agent effort' },
  { cmd: '/status', arg: '', desc: 'Show every agent\'s current status' },
  { cmd: '/pause', arg: '', desc: 'Pause all agents (kill switch)' },
  { cmd: '/resume', arg: '', desc: 'Resume all agents' },
  // Fun / misc
  { cmd: '/shrug', arg: '<message>', desc: 'Append ¯\\_(ツ)_/¯' },
  { cmd: '/help', arg: '', desc: 'List all commands' },
];

export default function MessageComposer({ onOpenAgentModal, onOpenView, onOpenSearch }: Props) {
  const { activeServer, activeChannel, agents, appendMessage, refreshTasks, refreshAgents } = useServer();
  const { addToast } = useNotifications();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionHidden, setMentionHidden] = useState(false);
  const [pending, setPending] = useState<MessageFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<ReturnType<typeof createRecognition>>(null);

  const uploadFiles = async (fileList: FileList | File[]) => {
    if (!activeServer) return;
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    setUploading(true);
    try {
      for (const f of arr) {
        const { file } = await filesApi.upload(activeServer.id, f, activeChannel?.id);
        setPending((p) => [...p, file]);
      }
    } catch (e) {
      addToast('Upload failed', (e as Error).message, 'error');
    } finally {
      setUploading(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); void uploadFiles(imgs); }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  };

  // Dictation via the Web Speech API — appends the transcript to the message.
  const startDictation = () => {
    if (listening) { recognitionRef.current?.stop(); return; }
    const r = createRecognition();
    if (!r) { addToast('Voice input unavailable', 'Speech recognition isn’t supported here.', 'error'); return; }
    recognitionRef.current = r;
    r.onresult = (e) => {
      const transcript = Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript).join(' ').trim();
      if (transcript) setText((t) => (t ? `${t} ${transcript}` : transcript));
    };
    r.onerror = () => { setListening(false); };
    r.onend = () => { setListening(false); ref.current?.focus(); };
    setListening(true);
    try { r.start(); } catch { setListening(false); }
  };

  const showPalette = text.startsWith('/') && !text.includes(' ');
  const matches = useMemo(
    () => (showPalette ? COMMANDS.filter((c) => c.cmd.startsWith(text.trim())) : []),
    [text, showPalette],
  );

  // ── @mention autocomplete ──────────────────────────────────────────────────
  const mention = useMemo(
    () => (mentionHidden ? null : activeMention(text, caret)),
    [text, caret, mentionHidden],
  );
  const mentionItems = useMemo<MentionItem[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const items: MentionItem[] = agents
      .filter((a) => a.enabled)
      .filter((a) => a.name.toLowerCase().includes(q) || a.name.replace(/\s+/g, '').toLowerCase().includes(q))
      .map((a) => ({ handle: a.name.replace(/\s+/g, ''), label: a.name, avatarUrl: a.avatarUrl, isManager: a.isManager }));
    if ('everyone'.includes(q)) items.push({ handle: 'everyone', label: 'everyone', isEveryone: true });
    return items.slice(0, 8);
  }, [mention, agents]);

  useEffect(() => setMentionIndex(0), [mention?.query]);

  const selectMention = (item: MentionItem) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(caret);
    const insert = '@' + item.handle + ' ';
    const next = before + insert + after;
    const pos = before.length + insert.length;
    setText(next);
    setMentionHidden(false);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionItems.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(mentionItems[mentionIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionHidden(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const runSlash = async (raw: string): Promise<boolean> => {
    if (!activeServer) return false;
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/agent':
        if (rest[0] === 'new') { onOpenAgentModal(); return true; }
        return false;
      case '/task':
        if (!arg) return false;
        await tasksApi.create(activeServer.id, { title: arg, channelId: activeChannel?.id, mode: 'managed' });
        await refreshTasks();
        addToast('Task created', arg, 'success');
        return true;
      case '/automate':
        if (!arg) return false;
        await sendPlain(`@Manager please create a workflow automation: ${arg}`);
        addToast('Asked the Manager to build a workflow', arg, 'success');
        return true;
      case '/run': {
        if (!arg) return false;
        const { workflows } = await wfApi.list(activeServer.id);
        const wf = workflows.find((w) => w.name.toLowerCase() === arg.toLowerCase())
          ?? workflows.find((w) => w.name.toLowerCase().includes(arg.toLowerCase()));
        if (!wf) { addToast('No such workflow', arg, 'error'); return true; }
        await wfApi.run(activeServer.id, wf.id);
        addToast('Workflow started', wf.name, 'success');
        return true;
      }
      case '/note':
        if (!arg) return false;
        await brainApi.createNote(activeServer.id, { title: arg, content: '' });
        addToast('Brain note created', arg, 'success');
        return true;
      case '/channel': {
        if (!arg) return false;
        await channelsApi.create(activeServer.id, arg.toLowerCase().replace(/\s+/g, '-'));
        addToast('Channel created', arg, 'success');
        return true;
      }
      case '/ask': {
        if (rest.length < 2) return false;
        await sendPlain(raw.replace(/^\/ask\s+/, '')); // "@Agent question" as a normal message
        return true;
      }
      case '/brain':
        onOpenView('brain');
        return true;
      case '/tasks':
        onOpenView('tasks');
        return true;
      case '/workflows':
        onOpenView('workflows');
        return true;
      case '/usage':
        onOpenView('usage');
        return true;
      case '/settings':
        onOpenView('settings');
        return true;
      case '/search':
        onOpenSearch(arg);
        return true;
      case '/summarize':
        await sendPlain(`@Manager please summarize #${activeChannel?.name ?? 'this channel'} into a Brain note.`);
        return true;
      case '/status': {
        const line = agents.length
          ? agents.map((a) => `${a.name}: ${a.status.toLowerCase()}`).join('  ·  ')
          : 'No agents yet.';
        addToast('Agent status', line, 'info');
        return true;
      }
      case '/pause':
        await agentsBulk('pause');
        return true;
      case '/resume':
        await agentsBulk('resume');
        return true;
      case '/model':
      case '/effort':
        return handleAgentTweak(cmd, rest);
      case '/shrug':
        await sendPlain(`${arg} ¯\\_(ツ)_/¯`.trim());
        return true;
      case '/help':
        addToast('Slash commands', COMMANDS.map((c) => c.cmd).join('  '), 'info');
        return true;
      default:
        return false;
    }
  };

  const agentsBulk = async (action: 'pause' | 'resume') => {
    if (!activeServer) return;
    await Promise.all(agents.map((a) => (action === 'pause' ? agentsApi.pause(activeServer.id, a.id) : agentsApi.resume(activeServer.id, a.id)).catch(() => {})));
    await refreshAgents();
    addToast(action === 'pause' ? 'Agents paused' : 'Agents resumed', undefined, 'success');
  };

  const handleAgentTweak = async (cmd: string, rest: string[]): Promise<boolean> => {
    if (!activeServer || rest.length < 2) return false;
    const handle = rest[0].replace(/^@/, '').toLowerCase();
    const agent = agents.find((a) => a.name.replace(/\s+/g, '').toLowerCase() === handle);
    if (!agent) { addToast('Agent not found', rest[0], 'error'); return true; }
    if (cmd === '/model') {
      const map: Record<string, string> = { haiku: 'HAIKU', sonnet: 'SONNET', opus: 'OPUS' };
      const mc = map[rest[1].toLowerCase()];
      if (!mc) return false;
      await agentsApi.patch(activeServer.id, agent.id, { modelClass: mc as never });
      addToast(`${agent.name} → ${rest[1]}`, undefined, 'success');
    } else {
      const map: Record<string, string> = { low: 'LOW', med: 'MEDIUM', medium: 'MEDIUM', high: 'HIGH' };
      const ef = map[rest[1].toLowerCase()];
      if (!ef) return false;
      await agentsApi.patch(activeServer.id, agent.id, { effort: ef as never });
      addToast(`${agent.name} effort → ${rest[1]}`, undefined, 'success');
    }
    await refreshAgents();
    return true;
  };

  const sendPlain = async (content: string, fileIds?: string[]) => {
    if (!activeServer || !activeChannel) return;
    const { message } = await msgApi.send(activeServer.id, activeChannel.id, content, undefined, fileIds);
    appendMessage(message);
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && pending.length === 0) || sending) return;
    setSending(true);
    try {
      // Slash commands only apply to text-only messages (no attachments).
      if (value.startsWith('/') && pending.length === 0) {
        const handled = await runSlash(value);
        if (handled) { setText(''); return; }
      }
      await sendPlain(value, pending.length ? pending.map((f) => f.id) : undefined);
      setText('');
      setPending([]);
    } catch (e) {
      addToast('Failed to send', (e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  if (!activeChannel) return null;

  return (
    <div className="px-6 pb-5 pt-1 relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="absolute inset-2 z-30 rounded-xl border-2 border-dashed border-clay bg-ink-900/80 flex items-center justify-center text-clay text-sm font-medium pointer-events-none">
          Drop files to attach
        </div>
      )}
      {/* @mention popup */}
      {mentionItems.length > 0 && (
        <div className="absolute bottom-full left-6 right-6 mb-2 bg-ink-800 border border-ink-600 rounded-xl overflow-hidden shadow-2xl animate-fade-in max-h-64 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ink-500 font-semibold">Mention an agent</div>
          {mentionItems.map((item, idx) => (
            <button
              key={item.handle}
              onMouseEnter={() => setMentionIndex(idx)}
              onClick={() => selectMention(item)}
              className={clsx('w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors', idx === mentionIndex ? 'bg-ink-700' : 'hover:bg-ink-750')}
            >
              {item.isEveryone ? (
                <span className="w-7 h-7 rounded-lg bg-clay/20 text-clay flex items-center justify-center text-sm font-bold shrink-0">@</span>
              ) : (
                <Avatar name={item.label} url={item.avatarUrl} size={28} ring={item.isManager ? 'ring-1 ring-clay' : undefined} />
              )}
              <span className={clsx('text-sm', item.isManager ? 'text-clay' : 'text-cream-100')}>
                {item.isEveryone ? '@everyone' : item.label}
              </span>
              {item.isEveryone && <span className="text-xs text-ink-500 ml-auto">notify every agent</span>}
              {item.isManager && !item.isEveryone && <span className="text-[10px] uppercase text-ink-500 ml-auto">manager</span>}
            </button>
          ))}
        </div>
      )}
      {matches.length > 0 && (
        <div className="absolute bottom-full left-6 right-6 mb-2 bg-ink-800 border border-ink-600 rounded-xl overflow-hidden shadow-2xl animate-fade-in">
          {matches.map((c) => (
            <button
              key={c.cmd}
              onClick={() => { setText(c.cmd + ' '); ref.current?.focus(); }}
              className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-ink-700 transition-colors"
            >
              <span className="font-mono text-clay text-sm">{c.cmd}</span>
              <span className="text-ink-500 text-xs font-mono">{c.arg}</span>
              <span className="text-cream-400 text-xs ml-auto">{c.desc}</span>
            </button>
          ))}
        </div>
      )}
      {/* Pending attachments */}
      {(pending.length > 0 || uploading) && (
        <div className="flex flex-wrap gap-2 mb-2">
          {pending.map((f) => (
            <div key={f.id} className="flex items-center gap-2 bg-ink-800 border border-ink-700 rounded-lg pl-2 pr-1 py-1 text-xs">
              {/^image\//.test(f.mimeType)
                ? <img src={f.url} alt={f.name} className="w-6 h-6 rounded object-cover" />
                : <span>📎</span>}
              <span className="text-cream-200 max-w-[160px] truncate">{f.name}</span>
              <button onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}
                className="text-ink-500 hover:text-red-400 px-1">✕</button>
            </div>
          ))}
          {uploading && <span className="text-xs text-ink-500 self-center animate-pulse">Uploading…</span>}
        </div>
      )}

      <div className={clsx('flex items-end gap-2 bg-ink-800 border rounded-xl px-3 py-2 transition-colors', 'border-ink-700 focus-within:border-clay')}>
        <input ref={fileRef} type="file" multiple hidden
          onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ''; }} />
        <button onClick={() => fileRef.current?.click()} title="Attach files"
          className="text-ink-500 hover:text-clay px-1 py-1 self-end transition-colors" aria-label="Attach files">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        {VOICE_INPUT && (
          <button onClick={startDictation} title={listening ? 'Stop dictation' : 'Dictate a message'}
            className={clsx('px-1 py-1 self-end transition-colors', listening ? 'text-clay animate-pulse' : 'text-ink-500 hover:text-clay')} aria-label="Dictate">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" />
            </svg>
          </button>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setMentionHidden(false); }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={`Message #${activeChannel.name}   —   / for commands, @ to mention, drop or paste files`}
          className="flex-1 bg-transparent resize-none max-h-40 text-sm text-cream-100 placeholder:text-ink-500 focus:outline-none py-1"
        />
        <button onClick={submit} disabled={(!text.trim() && pending.length === 0) || sending} className="text-clay hover:text-clay-400 disabled:text-ink-600 text-sm font-medium px-2 py-1 self-end">
          Send
        </button>
      </div>
    </div>
  );
}
