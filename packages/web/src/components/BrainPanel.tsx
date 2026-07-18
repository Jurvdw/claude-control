import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { brain as brainApi } from '../lib/api';
import type { BrainNote, NoteBacklink, NoteLink, GraphNode, GraphEdge } from '../lib/types';
import { Button, Input } from './ui';
import BrainGraph, { type NotePreview } from './BrainGraph';

// Rewrite [[wikilinks]] into markdown links with a "wiki:" scheme so the custom
// <a> renderer can resolve + navigate them. Handles [[Title]], [[Folder/Title]]
// and [[Title|alias]].
function linkifyWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    return `[${label}](wiki:${encodeURIComponent(target.trim())})`;
  });
}

// Detect an in-progress "[[query" at the caret (unclosed — no "]]" yet).
function activeWikiQuery(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const m = /\[\[([^\]\n]*)$/.exec(upto);
  if (!m) return null;
  return { start: caret - m[1].length - 2, query: m[1] };
}

// Resolve a wikilink target ("Folder/Title" or "Title") against the note index,
// mirroring the server's rules (case-insensitive; folder-qualified must match).
function resolveTarget(target: string, notes: BrainNote[]): BrainNote | undefined {
  const t = target.trim();
  const slash = t.lastIndexOf('/');
  const folder = slash === -1 ? undefined : t.slice(0, slash).trim().toLowerCase();
  const title = (slash === -1 ? t : t.slice(slash + 1)).trim().toLowerCase();
  const matches = notes.filter((n) => n.title.toLowerCase() === title);
  if (matches.length === 0) return undefined;
  if (folder !== undefined) return matches.find((n) => (n.folder ?? '').toLowerCase() === folder);
  return matches.find((n) => !n.folder) ?? matches[0];
}

export default function BrainPanel() {
  const { activeServer, brainNotes, proposals, refreshProposals } = useServer();
  const { addToast } = useNotifications();
  const [notes, setNotes] = useState<BrainNote[]>(brainNotes);
  const [selected, setSelected] = useState<BrainNote | null>(null);
  const [backlinks, setBacklinks] = useState<NoteBacklink[]>([]);
  const [outLinks, setOutLinks] = useState<NoteLink[]>([]);
  const [mode, setMode] = useState<'notes' | 'graph'>('graph');
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [graphNonce, setGraphNonce] = useState(0);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ folder: '', title: '', summary: '', content: '' });
  const [caret, setCaret] = useState(0);
  const [wikiIndex, setWikiIndex] = useState(0);
  const [wikiHidden, setWikiHidden] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setNotes(brainNotes), [brainNotes]);

  // Load the [[wikilink]] graph when the graph view is shown (and when notes change).
  useEffect(() => {
    if (mode !== 'graph' || !activeServer) return;
    let live = true;
    brainApi.graph(activeServer.id).then((g) => live && setGraph(g)).catch(() => {});
    return () => { live = false; };
  }, [mode, activeServer, notes.length, graphNonce]);

  // Create a [[wikilink]] by dragging between two nodes: append the link to the
  // source note's content and re-render the graph.
  const linkNotes = async (sourceId: string, targetId: string) => {
    if (!activeServer) return;
    const target = notes.find((n) => n.id === targetId);
    if (!target) return;
    const path = `${target.folder ? target.folder + '/' : ''}${target.title}`;
    try {
      const { note } = await brainApi.getNote(activeServer.id, sourceId);
      const content = note.content ?? '';
      if (new RegExp(`\\[\\[\\s*${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]`, 'i').test(content)
        || new RegExp(`\\[\\[\\s*${target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\||\\]\\])`, 'i').test(content)) {
        addToast('Already linked', `${note.title} → ${target.title}`, 'info');
        return;
      }
      const next = `${content.trimEnd()}\n\n[[${path}]]\n`;
      await brainApi.patchNote(activeServer.id, sourceId, { content: next });
      setGraphNonce((n) => n + 1);
      if (selected?.id === sourceId) await openNote({ ...selected });
      addToast('Linked', `${note.title} → ${target.title}`, 'success');
    } catch (e) {
      addToast('Failed to link', (e as Error).message, 'error');
    }
  };

  // ── [[wikilink]] autocomplete (in the note editor) ──────────────────────────
  const wiki = useMemo(
    () => (editing && !wikiHidden ? activeWikiQuery(draft.content, caret) : null),
    [editing, wikiHidden, draft.content, caret],
  );
  const wikiItems = useMemo(() => {
    if (!wiki) return [];
    const q = wiki.query.trim().toLowerCase();
    const path = (n: BrainNote) => `${n.folder ? n.folder + '/' : ''}${n.title}`;
    return notes
      .filter((n) => !selected || n.id !== selected.id) // don't link a note to itself
      .filter((n) => q === '' || path(n).toLowerCase().includes(q) || n.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [wiki, notes, selected]);

  useEffect(() => setWikiIndex(0), [wiki?.query]);

  const selectWiki = (n: BrainNote) => {
    if (!wiki) return;
    const target = `${n.folder ? n.folder + '/' : ''}${n.title}`;
    const insert = `[[${target}]]`;
    const before = draft.content.slice(0, wiki.start);
    const after = draft.content.slice(caret);
    const next = before + insert + after;
    const pos = before.length + insert.length;
    setDraft((d) => ({ ...d, content: next }));
    setWikiHidden(false);
    requestAnimationFrame(() => {
      const el = editorRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (wikiItems.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setWikiIndex((i) => (i + 1) % wikiItems.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setWikiIndex((i) => (i - 1 + wikiItems.length) % wikiItems.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectWiki(wikiItems[wikiIndex]); }
    else if (e.key === 'Escape') { e.preventDefault(); setWikiHidden(true); }
  };

  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? 0);

  const folders = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = q
      ? notes.filter((n) => n.title.toLowerCase().includes(q) || (n.folder ?? '').toLowerCase().includes(q) || (n.summary ?? '').toLowerCase().includes(q))
      : notes;
    const map: Record<string, BrainNote[]> = {};
    for (const n of visible) (map[n.folder || 'root'] ??= []).push(n);
    return map;
  }, [notes, filter]);

  const openNote = async (n: BrainNote) => {
    if (!activeServer) return;
    setEditing(false);
    const { note, links, backlinks } = await brainApi.getNote(activeServer.id, n.id);
    setSelected(note);
    // Default to [] so an older backend (which omits these) can't crash the view.
    setBacklinks(backlinks ?? []);
    setOutLinks(links ?? []);
    setDraft({ folder: note.folder ?? '', title: note.title, summary: note.summary ?? '', content: note.content ?? '' });
  };

  // Open a note from the graph (jump back to the notes view with it selected).
  const openById = (id: string) => {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    setMode('notes');
    void openNote(n);
  };

  // Edit a note straight from the graph (open it in the editor).
  const editById = async (id: string) => {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    setMode('notes');
    await openNote(n);
    setWikiHidden(false);
    setEditing(true);
  };

  // New note from the graph (switch to the notes editor with a blank draft).
  const newFromGraph = () => { setMode('notes'); startNew(); };

  // Lightweight note preview for the graph popover (title, summary, excerpt, edges).
  const fetchPreview = async (id: string): Promise<NotePreview | null> => {
    if (!activeServer) return null;
    try {
      const { note, links, backlinks } = await brainApi.getNote(activeServer.id, id);
      return {
        title: note.title,
        folder: note.folder ?? '',
        summary: note.summary ?? '',
        excerpt: (note.content ?? '').replace(/[#*`>_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220),
        links: links?.length ?? 0,
        backlinks: backlinks?.length ?? 0,
      };
    } catch {
      return null;
    }
  };

  // Navigate a clicked [[wikilink]] to its target note (index item → full note).
  const openTarget = (target: string) => {
    const hit = resolveTarget(target, notes);
    if (hit) void openNote(hit);
  };

  const enterEdit = () => { setWikiHidden(false); setEditing(true); };

  const startNew = () => {
    setSelected(null);
    setBacklinks([]);
    setWikiHidden(false);
    setEditing(true);
    setDraft({ folder: '', title: '', summary: '', content: '' });
  };

  const save = async () => {
    if (!activeServer || !draft.title.trim()) return;
    try {
      if (selected) {
        const { note } = await brainApi.patchNote(activeServer.id, selected.id, draft);
        setSelected(note);
        await openNote(note); // refresh links/backlinks after the edit
      } else {
        const { note } = await brainApi.createNote(activeServer.id, draft);
        setNotes((p) => [...p, note]);
        await openNote(note);
      }
      setEditing(false);
      addToast('Note saved', draft.title, 'success');
    } catch (e) {
      addToast('Save failed', (e as Error).message, 'error');
    }
  };

  // Export the open note as a downloadable Markdown file (with frontmatter).
  const downloadNote = () => {
    if (!selected) return;
    const fm = `---\ntitle: ${selected.title}\nfolder: ${selected.folder ?? ''}\n---\n\n`;
    const body = (selected.summary ? `> ${selected.summary}\n\n` : '') + (selected.content ?? '');
    const blob = new Blob([fm + body], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.title.replace(/[^\w.-]+/g, '_') || 'note'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyNote = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.content ?? '');
      addToast('Copied', selected.title, 'success');
    } catch {
      addToast('Copy failed', 'Clipboard unavailable', 'error');
    }
  };

  const deleteNote = async () => {
    if (!activeServer || !selected) return;
    const id = selected.id;
    try {
      await brainApi.deleteNote(activeServer.id, id);
      setNotes((p) => p.filter((n) => n.id !== id));
      setSelected(null);
      setEditing(false);
      setGraphNonce((n) => n + 1);
      addToast('Note deleted', undefined, 'info');
    } catch (e) {
      addToast('Delete failed', (e as Error).message, 'error');
    }
  };

  const pending = proposals.filter((p) => p.status === 'PENDING');

  const decide = async (id: string, ok: boolean) => {
    if (!activeServer) return;
    try {
      if (ok) await brainApi.approveProposal(activeServer.id, id);
      else await brainApi.rejectProposal(activeServer.id, id);
      await refreshProposals();
      addToast(ok ? 'Proposal approved' : 'Proposal rejected', undefined, ok ? 'success' : 'info');
    } catch (e) {
      addToast('Failed', (e as Error).message, 'error');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar: Notes / Graph toggle */}
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-ink-700">
        <div className="inline-flex rounded-lg bg-ink-800 border border-ink-700 p-0.5 text-xs font-medium">
          <button onClick={() => setMode('notes')}
            className={clsx('px-3 py-1 rounded-md transition-colors', mode === 'notes' ? 'bg-ink-700 text-cream-50' : 'text-cream-400 hover:text-cream-200')}>
            📄 Notes
          </button>
          <button onClick={() => setMode('graph')}
            className={clsx('px-3 py-1 rounded-md transition-colors', mode === 'graph' ? 'bg-ink-700 text-cream-50' : 'text-cream-400 hover:text-cream-200')}>
            🕸️ Graph
          </button>
        </div>
        <span className="ml-auto text-xs text-ink-500">{notes.length} note{notes.length === 1 ? '' : 's'}</span>
      </div>

      {mode === 'graph' ? (
        <div className="flex-1 min-h-0">
          <BrainGraph nodes={graph.nodes} edges={graph.edges} selectedId={selected?.id} onOpen={openById} onEdit={editById} onNew={newFromGraph} onLink={linkNotes} fetchPreview={fetchPreview} />
        </div>
      ) : (
      <div className="flex-1 flex min-h-0">
      {/* Tree */}
      <div className="w-64 shrink-0 border-r border-ink-700 overflow-y-auto p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs uppercase tracking-wide text-ink-500 font-semibold">Vault</span>
          <button onClick={startNew} className="text-ink-500 hover:text-clay text-lg leading-none">+</button>
        </div>
        {notes.length > 0 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter notes…"
            className="w-full mb-2 bg-ink-800 text-cream-100 rounded-lg px-2.5 py-1.5 text-xs border border-ink-700 focus:outline-none focus:border-clay"
          />
        )}
        {notes.length === 0 && <p className="text-xs text-ink-500 py-3">Empty vault. Agents and you can add notes; every agent reads this Brain.</p>}
        {notes.length > 0 && Object.keys(folders).length === 0 && <p className="text-xs text-ink-500 py-3">No notes match “{filter}”.</p>}
        {Object.entries(folders).map(([folder, items]) => (
          <div key={folder} className="mb-2">
            <div className="text-xs text-clay/80 font-medium px-1 mb-0.5">📁 {folder}</div>
            {items.map((n) => (
              <button key={n.id} onClick={() => openNote(n)}
                className={clsx('w-full text-left px-2 py-1 rounded text-sm truncate transition-colors', selected?.id === n.id ? 'bg-ink-700 text-cream-50' : 'text-cream-300 hover:bg-ink-750')}>
                {n.title}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Editor / viewer */}
      <div className="flex-1 overflow-y-auto p-6">
        {pending.length > 0 && (
          <div className="mb-5 space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="bg-ink-800 border border-amber-500/40 rounded-xl p-4 animate-fade-in">
                <div className="text-sm text-amber-300 font-medium mb-1">Proposed Brain change{p.title ? `: ${p.title}` : ''}</div>
                <p className="text-xs text-cream-400 line-clamp-3 whitespace-pre-wrap">{p.content}</p>
                <div className="flex gap-2 mt-3">
                  <Button onClick={() => decide(p.id, true)}>Approve</Button>
                  <Button variant="ghost" onClick={() => decide(p.id, false)}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!selected && !editing && (
          <div className="h-full flex flex-col items-center justify-center text-ink-500">
            <div className="text-4xl mb-2">🧠</div>
            <p className="text-cream-300">The shared Brain</p>
            <p className="text-sm">Select a note, or create one. Agents read a compact index and pull notes on demand.</p>
          </div>
        )}

        {(selected || editing) && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-ink-500">{editing ? 'Editing' : selected?.folder || 'root'}</span>
              <div className="flex gap-2 items-center">
                {!editing && selected && (
                  <>
                    <button onClick={copyNote} title="Copy markdown" className="text-ink-500 hover:text-cream-200 px-1">⧉</button>
                    <button onClick={downloadNote} title="Download .md" className="text-ink-500 hover:text-cream-200 px-1">⬇</button>
                    <button onClick={deleteNote} title="Delete note" className="text-ink-500 hover:text-red-400 px-1">🗑</button>
                  </>
                )}
                {!editing && <Button variant="ghost" onClick={enterEdit}>Edit</Button>}
                {editing && <Button onClick={save}>Save</Button>}
              </div>
            </div>
            {editing ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <Input placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                  <Input placeholder="Folder (e.g. About)" value={draft.folder} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} />
                </div>
                <Input placeholder="One-line summary (for the Brain index)" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
                <div className="relative">
                  <textarea
                    ref={editorRef}
                    value={draft.content}
                    onChange={(e) => { setDraft({ ...draft, content: e.target.value }); setCaret(e.target.selectionStart ?? e.target.value.length); setWikiHidden(false); }}
                    onKeyUp={(e) => syncCaret(e.target as HTMLTextAreaElement)}
                    onClick={(e) => syncCaret(e.target as HTMLTextAreaElement)}
                    onKeyDown={onEditorKeyDown}
                    rows={16}
                    placeholder="# Markdown content…   ([[ to link a note)"
                    className="w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-2 text-sm font-mono border border-ink-700 focus:outline-none focus:border-clay resize-none" />
                  {wikiItems.length > 0 && (
                    <div className="absolute left-3 top-full mt-1 z-20 w-72 bg-ink-800 border border-ink-600 rounded-xl overflow-hidden shadow-2xl animate-fade-in max-h-64 overflow-y-auto">
                      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ink-500 font-semibold">Link a note</div>
                      {wikiItems.map((n, idx) => (
                        <button
                          key={n.id}
                          type="button"
                          onMouseEnter={() => setWikiIndex(idx)}
                          onClick={() => selectWiki(n)}
                          className={clsx('w-full flex items-center gap-2 px-3 py-2 text-left transition-colors', idx === wikiIndex ? 'bg-ink-700' : 'hover:bg-ink-750')}
                        >
                          <span className="text-clay text-xs">[[</span>
                          <span className="text-sm text-cream-100 truncate">
                            {n.folder ? <span className="text-ink-500">{n.folder}/</span> : null}{n.title}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="markdown-body text-cream-100 text-sm">
                <h1 className="text-xl font-semibold text-cream-50 mb-1">{selected?.title}</h1>
                {selected?.summary && <p className="text-cream-400 italic mb-4">{selected.summary}</p>}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => {
                      if (href?.startsWith('wiki:')) {
                        const target = decodeURIComponent(href.slice(5));
                        const hit = resolveTarget(target, notes);
                        return hit ? (
                          <button type="button" onClick={() => openTarget(target)}
                            className="text-clay hover:underline font-medium">{children}</button>
                        ) : (
                          <span title="No note with this title yet"
                            className="text-clay/50 underline decoration-dotted cursor-help">{children}</span>
                        );
                      }
                      return <a href={href} target="_blank" rel="noreferrer" className="text-clay hover:underline">{children}</a>;
                    },
                  }}
                >{linkifyWikilinks(selected?.content || '_(empty)_')}</ReactMarkdown>

                {outLinks.length > 0 && (
                  <div className="mt-8 pt-4 border-t border-ink-700">
                    <div className="text-xs uppercase tracking-wide text-ink-500 font-semibold mb-2">
                      ↗ Links ({outLinks.length})
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {outLinks.map((l, i) =>
                        l.noteId ? (
                          <button key={i} type="button"
                            onClick={() => l.noteId && openById(l.noteId)}
                            className="text-xs px-2 py-1 rounded-md bg-ink-800 border border-ink-700 text-cream-300 hover:border-clay hover:text-clay transition-colors">
                            {l.folder ? <span className="text-ink-500">{l.folder}/</span> : null}{l.title}
                          </button>
                        ) : (
                          <span key={i} title="No note with this title yet"
                            className="text-xs px-2 py-1 rounded-md bg-ink-850 border border-dashed border-ink-700 text-ink-500">
                            {l.label} <span className="text-ink-600">· unresolved</span>
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                )}

                {backlinks.length > 0 && (
                  <div className="mt-8 pt-4 border-t border-ink-700">
                    <div className="text-xs uppercase tracking-wide text-ink-500 font-semibold mb-2">
                      🔗 Linked mentions ({backlinks.length})
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {backlinks.map((b) => (
                        <button key={b.id} type="button"
                          onClick={() => { const n = notes.find((x) => x.id === b.id); if (n) void openNote(n); }}
                          className="text-xs px-2 py-1 rounded-md bg-ink-800 border border-ink-700 text-cream-300 hover:border-clay hover:text-clay transition-colors">
                          {b.folder ? <span className="text-ink-500">{b.folder}/</span> : null}{b.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </div>
      )}
    </div>
  );
}
