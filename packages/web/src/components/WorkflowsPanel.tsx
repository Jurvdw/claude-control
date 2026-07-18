import { memo, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  ReactFlow, Background, Panel, Handle, Position, addEdge, useReactFlow,
  useNodesState, useEdgesState, type Node, type Edge, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { workflows as wfApi, hooks as hooksApi } from '../lib/api';
import { onSocketEvent } from '../lib/socket';
import type { Workflow, WorkflowRun, WorkflowGraph } from '../lib/types';
import { WORKFLOW_TEMPLATES } from '../lib/workflowTemplates';
import { Button } from './ui';

// ── Node metadata ────────────────────────────────────────────────────────────
type Kind = 'trigger.manual' | 'trigger.schedule' | 'trigger.webhook' | 'agent.run' | 'channel.post' | 'brain.write' | 'condition' | 'http.request' | 'delay' | 'workflow.run';

type Cat = 'Triggers' | 'Actions' | 'Logic';
const META: Record<Kind, { label: string; icon: string; color: string; inputs: number; branches: boolean; desc: string; cat: Cat }> = {
  'trigger.manual': { label: 'Manual trigger', icon: '▶', color: '#63e6be', inputs: 0, branches: false, desc: 'Starts when you press Run', cat: 'Triggers' },
  'trigger.schedule': { label: 'Schedule', icon: '⏰', color: '#63e6be', inputs: 0, branches: false, desc: 'Run automatically on a cron schedule', cat: 'Triggers' },
  'trigger.webhook': { label: 'Webhook', icon: '🪝', color: '#63e6be', inputs: 0, branches: false, desc: 'Run when your webhook URL is called', cat: 'Triggers' },
  'agent.run': { label: 'Run agent', icon: '🤖', color: '#d97757', inputs: 1, branches: false, desc: 'Have an agent do a task', cat: 'Actions' },
  'channel.post': { label: 'Post message', icon: '💬', color: '#6ea8fe', inputs: 1, branches: false, desc: 'Post a message to a channel', cat: 'Actions' },
  'brain.write': { label: 'Write Brain note', icon: '🧠', color: '#b197fc', inputs: 1, branches: false, desc: 'Save or update a note in the Brain', cat: 'Actions' },
  'http.request': { label: 'HTTP request', icon: '🌐', color: '#74c0fc', inputs: 1, branches: false, desc: 'Call an external API or URL', cat: 'Actions' },
  'workflow.run': { label: 'Run workflow', icon: '⚙️', color: '#f783ac', inputs: 1, branches: false, desc: 'Start another workflow', cat: 'Actions' },
  'condition': { label: 'Condition', icon: '⑂', color: '#ffd43b', inputs: 1, branches: true, desc: 'Branch on a true / false check', cat: 'Logic' },
  'delay': { label: 'Delay', icon: '⏱', color: '#ffa94d', inputs: 1, branches: false, desc: 'Wait a while, then continue', cat: 'Logic' },
};

const PALETTE: Kind[] = ['trigger.schedule', 'trigger.webhook', 'agent.run', 'channel.post', 'brain.write', 'http.request', 'workflow.run', 'condition', 'delay'];
const CAT_ORDER: Cat[] = ['Triggers', 'Actions', 'Logic'];

interface NodeData extends Record<string, unknown> {
  kind: Kind;
  config: Record<string, unknown>;
  runStatus?: 'ok' | 'error' | 'skipped' | 'running';
}

// Summary line shown inside a node.
function summarize(kind: Kind, c: Record<string, unknown>): string {
  switch (kind) {
    case 'trigger.schedule': return c.cron ? `cron: ${c.cron}` : 'set a schedule';
    case 'trigger.webhook': return c.event ? `on “${c.event}”` : 'on any call';
    case 'agent.run': return (c.agentName as string) || 'pick an agent';
    case 'channel.post': return c.channelName ? `#${c.channelName}` : 'pick a channel';
    case 'brain.write': return (c.title as string) || 'note title';
    case 'condition': return `${c.mode || 'notEmpty'}${c.value ? `: ${c.value}` : ''}`;
    case 'http.request': return `${(c.method as string) || 'GET'} ${(c.url as string) || 'url…'}`;
    case 'delay': return `wait ${(c.seconds as number) ?? 5}s`;
    case 'workflow.run': return (c.workflowName as string) || 'pick a workflow';
    default: return 'starts the workflow';
  }
}

// True when a node still needs configuration before it can run.
function isIncomplete(kind: Kind, c: Record<string, unknown>): boolean {
  switch (kind) {
    case 'agent.run': return !c.agentId;
    case 'channel.post': return !c.channelId;
    case 'workflow.run': return !c.workflowId;
    case 'http.request': return !String(c.url ?? '').trim();
    case 'trigger.schedule': return !String(c.cron ?? '').trim();
    default: return false;
  }
}

const WFNodeView = memo(function WFNodeView({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const m = META[d.kind];
  const incomplete = isIncomplete(d.kind, d.config);
  const statusRing =
    d.runStatus === 'ok' ? 'ring-2 ring-emerald-400' :
    d.runStatus === 'error' ? 'ring-2 ring-red-400' :
    d.runStatus === 'running' ? 'ring-2 ring-clay animate-pulse' :
    d.runStatus === 'skipped' ? 'opacity-50' : '';
  return (
    <div className={clsx('rounded-lg border bg-ink-800 w-[150px] shadow-md transition-all',
      selected ? 'border-clay' : 'border-ink-600', statusRing)}>
      {m.inputs > 0 && <Handle type="target" position={Position.Left} className="!bg-ink-400 !w-2 !h-2" />}
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-t-lg" style={{ background: `${m.color}18` }}>
        <span className="text-[11px]" style={{ color: m.color }}>{m.icon}</span>
        <span className="text-[11px] font-semibold text-cream-100 truncate">{m.label}</span>
        {incomplete && <span title="Needs configuration" className="ml-auto text-amber-400 text-[11px]">⚠</span>}
      </div>
      <div className="px-2 py-1 text-[10px] text-cream-400 truncate border-t border-ink-700/60">{summarize(d.kind, d.config)}</div>
      {m.branches ? (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: '38%' }} className="!bg-emerald-400 !w-2 !h-2" />
          <Handle id="false" type="source" position={Position.Right} style={{ top: '72%' }} className="!bg-red-400 !w-2 !h-2" />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="!bg-ink-400 !w-2 !h-2" />
      )}
    </div>
  );
});

const nodeTypes = { wf: WFNodeView };

// Dark, compact zoom controls (the default React Flow ones are white/ugly).
// Uses short animation durations so zooming feels snappy.
function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const btn = 'w-7 h-7 flex items-center justify-center rounded-md bg-ink-800/90 border border-ink-700 text-cream-300 hover:bg-ink-700 hover:text-cream-50 transition-colors backdrop-blur text-sm leading-none';
  return (
    <Panel position="bottom-left" className="!m-3 flex flex-col gap-1">
      <button className={btn} title="Zoom in" onClick={() => zoomIn({ duration: 120 })}>+</button>
      <button className={btn} title="Zoom out" onClick={() => zoomOut({ duration: 120 })}>−</button>
      <button className={btn} title="Fit to view" onClick={() => fitView({ duration: 200, padding: 0.2 })}>⤢</button>
    </Panel>
  );
}

// Searchable, categorized node picker with one-line descriptions.
function AddNodeMenu({ onPick, onClose }: { onPick: (k: Kind) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const matches = PALETTE.filter((k) => !query || META[k].label.toLowerCase().includes(query) || META[k].desc.toLowerCase().includes(query));
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute left-0 top-full mt-1 z-20 w-72 bg-ink-800 border border-ink-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="p-2 border-b border-ink-700">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search nodes…"
            className="w-full bg-ink-850 text-cream-100 rounded-lg px-2.5 py-1.5 text-sm border border-ink-700 focus:outline-none focus:border-clay" />
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {CAT_ORDER.map((cat) => {
            const items = matches.filter((k) => META[k].cat === cat);
            if (!items.length) return null;
            return (
              <div key={cat}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-500 font-semibold">{cat}</div>
                {items.map((k) => (
                  <button key={k} onClick={() => onPick(k)} className="w-full flex items-start gap-2.5 px-3 py-1.5 text-left hover:bg-ink-750">
                    <span className="text-sm mt-0.5 shrink-0" style={{ color: META[k].color }}>{META[k].icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm text-cream-100">{META[k].label}</span>
                      <span className="block text-[11px] text-ink-500 leading-snug">{META[k].desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {matches.length === 0 && <div className="px-3 py-3 text-xs text-ink-500">No nodes match “{q}”.</div>}
        </div>
      </div>
    </>
  );
}

// ── Graph ⇄ React Flow conversion ────────────────────────────────────────────
function toRF(graph: WorkflowGraph): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = (graph.nodes ?? []).map((n) => ({
    id: n.id,
    type: 'wf',
    position: n.position ?? { x: 0, y: 0 },
    data: { kind: n.type as Kind, config: n.data ?? {} } as NodeData,
  }));
  const edges: Edge[] = (graph.edges ?? []).map((e, i) => ({
    id: e.id ?? `e${i}`,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    animated: true,
    style: { stroke: '#6b6659' },
  }));
  return { nodes, edges };
}

function fromRF(nodes: Node[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.data as NodeData).kind,
      position: n.position,
      data: (n.data as NodeData).config,
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

export default function WorkflowsPanel() {
  const { activeServer, agents, channels } = useServer();
  const { addToast } = useNotifications();
  const [list, setList] = useState<Workflow[]>([]);
  const [current, setCurrent] = useState<Workflow | null>(null);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selNode, setSelNode] = useState<Node | null>(null);
  const [dirty, setDirty] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const idc = useRef(0);
  const restoredRef = useRef<string | null>(null);
  const selKey = activeServer ? `cc.wf.sel.${activeServer.id}` : '';

  useEffect(() => {
    if (!activeServer) return;
    hooksApi.webhookUrl(activeServer.id).then(({ url }) => setWebhookUrl(url)).catch(() => {});
  }, [activeServer]);

  const refreshList = useCallback(() => {
    if (!activeServer) return;
    wfApi.list(activeServer.id).then(({ workflows }) => setList(workflows)).catch(() => {});
  }, [activeServer]);

  useEffect(refreshList, [refreshList]);

  // Refresh the list when workflows change (e.g. an agent creates one).
  useEffect(() => onSocketEvent('workflow:updated', () => refreshList()), [refreshList]);

  const load = useCallback(async (wf: Workflow) => {
    if (!activeServer) return;
    const { workflow, runs } = await wfApi.get(activeServer.id, wf.id);
    setCurrent(workflow);
    // Remember the open workflow so the panel restores it next time it mounts.
    try { localStorage.setItem(`cc.wf.sel.${activeServer.id}`, workflow.id); } catch { /* ignore */ }
    const { nodes, edges } = toRF(workflow.graph ?? { nodes: [], edges: [] });
    setRfNodes(nodes);
    setRfEdges(edges);
    setSelNode(null);
    setDirty(false);
    setRuns(runs);
    setRun(runs[0] ?? null);
  }, [activeServer, setRfNodes, setRfEdges]);

  // Session memory: once the list is available, re-open the last workflow the
  // user had open on this server (survives tab switches / reloads).
  useEffect(() => {
    if (!activeServer || current || list.length === 0) return;
    if (restoredRef.current === activeServer.id) return;
    restoredRef.current = activeServer.id;
    const savedId = (() => { try { return localStorage.getItem(selKey); } catch { return null; } })();
    const wf = savedId ? list.find((w) => w.id === savedId) : null;
    if (wf) void load(wf);
  }, [activeServer, current, list, load, selKey]);

  // Live run updates for the open workflow.
  useEffect(() => {
    if (!current) return;
    const off = onSocketEvent('workflow:run', (data: unknown) => {
      const { workflowId, run: r } = data as { workflowId: string; run: WorkflowRun };
      if (workflowId !== current.id) return;
      setRun(r);
      setRuns((prev) => [r, ...prev.filter((x) => x.id !== r.id)].slice(0, 20));
    });
    return off;
  }, [current]);

  // Paint node run status from the latest run's log.
  useEffect(() => {
    const byNode = new Map((run?.log ?? []).map((l) => [l.nodeId, l.status]));
    setRfNodes((ns) => ns.map((n) => ({ ...n, data: { ...(n.data as NodeData), runStatus: byNode.get(n.id) } })));
  }, [run, setRfNodes]);

  const onConnect = useCallback((c: Connection) => {
    setRfEdges((eds) => addEdge({ ...c, animated: true, style: { stroke: '#6b6659' } }, eds));
    setDirty(true);
  }, [setRfEdges]);

  const addNode = (kind: Kind) => {
    const id = `n${Date.now()}_${idc.current++}`;
    const node: Node = {
      id, type: 'wf',
      position: { x: 120 + Math.random() * 240, y: 120 + Math.random() * 160 },
      data: { kind, config: defaultConfig(kind) } as NodeData,
    };
    setRfNodes((ns) => [...ns, node]);
    setSelNode(node);
    setShowAddMenu(false);
    setDirty(true);
  };

  const updateSelConfig = (patch: Record<string, unknown>) => {
    if (!selNode) return;
    setRfNodes((ns) => ns.map((n) => {
      if (n.id !== selNode.id) return n;
      const data = n.data as NodeData;
      const next = { ...n, data: { ...data, config: { ...data.config, ...patch } } };
      setSelNode(next);
      return next;
    }));
    setDirty(true);
  };

  const deleteSel = () => {
    if (!selNode) return;
    setRfNodes((ns) => ns.filter((n) => n.id !== selNode.id));
    setRfEdges((es) => es.filter((e) => e.source !== selNode.id && e.target !== selNode.id));
    setSelNode(null);
    setDirty(true);
  };

  const save = async () => {
    if (!activeServer || !current) return;
    try {
      const graph = fromRF(rfNodes, rfEdges);
      const { workflow } = await wfApi.patch(activeServer.id, current.id, { graph });
      setCurrent(workflow);
      setDirty(false);
      addToast('Workflow saved', workflow.name, 'success');
      refreshList();
    } catch (e) {
      addToast('Save failed', (e as Error).message, 'error');
    }
  };

  const runNow = async () => {
    if (!activeServer || !current) return;
    if (dirty) await save();
    try {
      await wfApi.run(activeServer.id, current.id);
      addToast('Workflow started', current.name, 'success');
    } catch (e) {
      addToast("Couldn't run", (e as Error).message, 'error');
    }
  };

  const toggleEnabled = async () => {
    if (!activeServer || !current) return;
    const { workflow } = await wfApi.patch(activeServer.id, current.id, { enabled: !current.enabled });
    setCurrent(workflow);
    refreshList();
  };

  const createWorkflow = async () => {
    if (!activeServer) return;
    const graph: WorkflowGraph = { nodes: [{ id: 'trigger', type: 'trigger.manual', position: { x: 80, y: 160 }, data: {} }], edges: [] };
    const { workflow } = await wfApi.create(activeServer.id, { name: 'New workflow', graph });
    refreshList();
    load(workflow);
  };

  const removeWorkflow = async () => {
    if (!activeServer || !current) return;
    await wfApi.delete(activeServer.id, current.id);
    try { if (localStorage.getItem(selKey) === current.id) localStorage.removeItem(selKey); } catch { /* ignore */ }
    setCurrent(null);
    refreshList();
  };

  const createFromTemplate = async (templateId: string) => {
    if (!activeServer) return;
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    setShowTemplates(false);
    const { workflow } = await wfApi.create(activeServer.id, { name: tpl.name, description: tpl.blurb, graph: tpl.build() });
    refreshList();
    load(workflow);
    addToast('Workflow created', `From “${tpl.name}” template — wire up the agents & channels.`, 'success');
  };

  const duplicateWorkflow = async () => {
    if (!activeServer || !current) return;
    if (dirty) await save();
    const graph = fromRF(rfNodes, rfEdges);
    const { workflow } = await wfApi.create(activeServer.id, { name: `${current.name} copy`, description: current.description, graph, enabled: false });
    refreshList();
    load(workflow);
    addToast('Workflow duplicated', workflow.name, 'success');
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* Workflow list */}
      <div className="w-56 shrink-0 border-r border-ink-800 flex flex-col">
        <div className="flex items-center justify-between px-3 h-11 border-b border-ink-800">
          <span className="text-xs uppercase tracking-wide text-ink-500 font-semibold">Workflows</span>
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <button onClick={() => setShowTemplates((s) => !s)} title="Start from a template"
                className="text-ink-400 hover:text-cream-200 text-sm leading-none px-1">✨</button>
              {showTemplates && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowTemplates(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 w-64 bg-ink-800 border border-ink-700 rounded-xl shadow-2xl py-1 max-h-96 overflow-y-auto">
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-ink-500 font-semibold">Templates</div>
                    {WORKFLOW_TEMPLATES.map((t) => (
                      <button key={t.id} onClick={() => createFromTemplate(t.id)}
                        className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-ink-750">
                        <span className="text-base leading-none mt-0.5">{t.icon}</span>
                        <span className="min-w-0">
                          <span className="block text-sm text-cream-100">{t.name}</span>
                          <span className="block text-[11px] text-ink-500 leading-snug">{t.blurb}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={createWorkflow} title="Blank workflow" className="text-clay hover:text-clay-400 text-lg leading-none">+</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {list.length === 0 && <p className="text-xs text-ink-500 p-2">No workflows yet. Create one, or ask an agent to build an automation.</p>}
          {list.map((w) => (
            <button key={w.id} onClick={() => load(w)}
              className={clsx('w-full text-left px-2.5 py-2 rounded-lg transition-colors', current?.id === w.id ? 'bg-ink-750' : 'hover:bg-ink-800')}>
              <div className="flex items-center gap-2">
                <span className={clsx('w-1.5 h-1.5 rounded-full', w.enabled ? 'bg-emerald-400' : 'bg-ink-500')} />
                <span className="text-sm text-cream-100 truncate">{w.name}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      {current ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Toolbar */}
          <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-ink-800">
            <input value={current.name}
              onChange={(e) => setCurrent({ ...current, name: e.target.value })}
              onBlur={() => activeServer && wfApi.patch(activeServer.id, current.id, { name: current.name }).then(refreshList)}
              className="bg-transparent text-sm font-semibold text-cream-50 focus:outline-none focus:bg-ink-800 rounded px-1.5 py-1 w-52" />
            <div className="relative">
              <button onClick={() => setShowAddMenu((s) => !s)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-cream-300">+ Add node</button>
              {showAddMenu && <AddNodeMenu onPick={addNode} onClose={() => setShowAddMenu(false)} />}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={toggleEnabled} className={clsx('text-xs px-2.5 py-1.5 rounded-lg', current.enabled ? 'bg-emerald-600/20 text-emerald-300' : 'bg-ink-800 text-ink-400')}>
                {current.enabled ? 'Enabled' : 'Disabled'}
              </button>
              {dirty && <Button variant="ghost" onClick={save}>Save</Button>}
              <div className="relative">
                <button onClick={() => setShowHistory((h) => !h)} title="Run history"
                  className="text-xs px-2 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-cream-300">🕘</button>
                {showHistory && (
                  <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-ink-800 border border-ink-700 rounded-xl shadow-2xl py-1 max-h-72 overflow-y-auto">
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-ink-500 font-semibold">Run history</div>
                    {runs.length === 0 && <div className="px-3 py-2 text-xs text-ink-500">No runs yet.</div>}
                    {runs.map((r) => (
                      <button key={r.id} onClick={() => { setRun(r); setShowHistory(false); }}
                        className={clsx('w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-ink-750', run?.id === r.id && 'bg-ink-750')}>
                        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', r.status === 'ok' ? 'bg-emerald-400' : r.status === 'error' ? 'bg-red-400' : 'bg-clay')} />
                        <span className="text-cream-300 flex-1">{r.trigger}</span>
                        <span className="text-ink-500">{new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button onClick={runNow}>▶ Run</Button>
              <button onClick={duplicateWorkflow} title="Duplicate workflow" className="text-ink-500 hover:text-cream-200 px-1.5">⧉</button>
              <button onClick={removeWorkflow} title="Delete workflow" className="text-ink-500 hover:text-red-400 px-1.5">🗑</button>
            </div>
          </div>

          <div className="flex-1 flex min-h-0">
            <div className="flex-1 min-w-0 relative">
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type === 'position' || x.type === 'remove')) setDirty(true); }}
                onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type === 'remove')) setDirty(true); }}
                onConnect={onConnect}
                onNodeClick={(_, n) => setSelNode(n)}
                onPaneClick={() => setSelNode(null)}
                nodeTypes={nodeTypes}
                fitView
                minZoom={0.3}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
                className="bg-ink-900"
              >
                <Background color="#2a2822" gap={20} />
                <CanvasControls />
              </ReactFlow>

              {/* Run log strip */}
              {run && (
                <div className="absolute bottom-3 left-3 right-3 max-h-40 overflow-y-auto bg-ink-850/95 border border-ink-700 rounded-xl p-3 backdrop-blur text-xs">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={clsx('w-2 h-2 rounded-full', run.status === 'ok' ? 'bg-emerald-400' : run.status === 'error' ? 'bg-red-400' : 'bg-clay animate-pulse')} />
                    <span className="text-cream-200 font-medium">Last run — {run.status}</span>
                    {run.error && <span className="text-red-400 truncate">· {run.error}</span>}
                  </div>
                  <div className="space-y-0.5">
                    {run.log.map((l, i) => (
                      <div key={i} className="flex items-start gap-2 text-cream-400">
                        <span className={clsx('shrink-0', l.status === 'ok' ? 'text-emerald-400' : l.status === 'error' ? 'text-red-400' : 'text-ink-500')}>
                          {l.status === 'ok' ? '✓' : l.status === 'error' ? '✕' : '·'}
                        </span>
                        <span className="text-ink-400 shrink-0">{l.type}</span>
                        <span className="truncate">{l.error || l.output || ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Config drawer */}
            {selNode && (
              <div className="w-72 shrink-0 border-l border-ink-800 overflow-y-auto p-4">
                <NodeConfig
                  node={selNode}
                  agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                  channels={channels.map((c) => ({ id: c.id, name: c.name }))}
                  workflows={list.filter((w) => w.id !== current.id).map((w) => ({ id: w.id, name: w.name }))}
                  webhookUrl={webhookUrl}
                  onChange={updateSelConfig}
                  onDelete={deleteSel}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-ink-900">
          <div className="text-center max-w-sm">
            <div className="text-4xl mb-2">⚙️</div>
            <p className="text-cream-300">Build an automation</p>
            <p className="text-sm text-ink-500 mt-1">Chain triggers and actions on a canvas — or ask an agent to create one for you.</p>
            <Button className="mt-4" onClick={createWorkflow}>New workflow</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function defaultConfig(kind: Kind): Record<string, unknown> {
  switch (kind) {
    case 'trigger.schedule': return { cron: '0 9 * * *' };
    case 'trigger.webhook': return { event: '' };
    case 'agent.run': return { prompt: '{{input}}' };
    case 'channel.post': return { text: '{{input}}' };
    case 'brain.write': return { title: '', content: '{{input}}' };
    case 'condition': return { mode: 'notEmpty', value: '' };
    case 'http.request': return { method: 'GET', url: '', headers: '', body: '{{input}}' };
    case 'delay': return { seconds: 5 };
    case 'workflow.run': return {};
    default: return {};
  }
}

function NodeConfig({ node, agents, channels, workflows, webhookUrl, onChange, onDelete }: {
  node: Node;
  agents: { id: string; name: string }[];
  channels: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
  webhookUrl: string;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const d = node.data as NodeData;
  const c = d.config;
  const kind = d.kind;
  const label = (t: string) => <label className="text-xs text-ink-500 block mb-1 mt-3">{t}</label>;
  const input = 'w-full bg-ink-800 text-cream-100 rounded-lg px-2.5 py-1.5 text-sm border border-ink-700 focus:outline-none focus:border-clay';

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm text-cream-100 font-medium">
          <span>{META[kind].icon}</span> {META[kind].label}
        </div>
        <button onClick={onDelete} className="text-ink-500 hover:text-red-400 text-xs">Delete</button>
      </div>

      {kind === 'trigger.schedule' && (
        <>
          {label('Cron expression')}
          <input className={input} value={String(c.cron ?? '')} onChange={(e) => onChange({ cron: e.target.value })} placeholder="0 9 * * *" />
          <p className="text-[11px] text-ink-600 mt-1">min hour day month weekday · e.g. "0 9 * * *" = 9:00 daily</p>
        </>
      )}

      {kind === 'agent.run' && (
        <>
          {label('Agent')}
          <select className={input} value={String(c.agentId ?? '')}
            onChange={(e) => { const a = agents.find((x) => x.id === e.target.value); onChange({ agentId: e.target.value, agentName: a?.name }); }}>
            <option value="">— pick —</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {label('Prompt')}
          <textarea rows={5} className={input} value={String(c.prompt ?? '')} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="What should the agent do? Use {{input}} for the previous step's output." />
        </>
      )}

      {kind === 'channel.post' && (
        <>
          {label('Channel')}
          <select className={input} value={String(c.channelId ?? '')}
            onChange={(e) => { const ch = channels.find((x) => x.id === e.target.value); onChange({ channelId: e.target.value, channelName: ch?.name }); }}>
            <option value="">— pick —</option>
            {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
          </select>
          {label('Message')}
          <textarea rows={5} className={input} value={String(c.text ?? '')} onChange={(e) => onChange({ text: e.target.value })} placeholder="{{input}}" />
        </>
      )}

      {kind === 'brain.write' && (
        <>
          {label('Title')}
          <input className={input} value={String(c.title ?? '')} onChange={(e) => onChange({ title: e.target.value })} />
          {label('Folder (optional)')}
          <input className={input} value={String(c.folder ?? '')} onChange={(e) => onChange({ folder: e.target.value })} />
          {label('Content')}
          <textarea rows={5} className={input} value={String(c.content ?? '')} onChange={(e) => onChange({ content: e.target.value })} placeholder="{{input}}" />
        </>
      )}

      {kind === 'condition' && (
        <>
          {label('Mode')}
          <select className={input} value={String(c.mode ?? 'notEmpty')} onChange={(e) => onChange({ mode: e.target.value })}>
            <option value="notEmpty">Input is not empty</option>
            <option value="contains">Input contains…</option>
            <option value="equals">Input equals…</option>
          </select>
          {c.mode && c.mode !== 'notEmpty' && (
            <>
              {label('Value')}
              <input className={input} value={String(c.value ?? '')} onChange={(e) => onChange({ value: e.target.value })} />
            </>
          )}
          <p className="text-[11px] text-ink-600 mt-2">Green handle = true branch, red = false.</p>
        </>
      )}

      {kind === 'http.request' && (
        <>
          {label('Method')}
          <select className={input} value={String(c.method ?? 'GET')} onChange={(e) => onChange({ method: e.target.value })}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {label('URL')}
          <input className={input} value={String(c.url ?? '')} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://api.example.com/…" />
          {label('Headers (JSON, optional)')}
          <textarea rows={2} className={input} value={String(c.headers ?? '')} onChange={(e) => onChange({ headers: e.target.value })} placeholder='{"Authorization": "Bearer …"}' />
          {String(c.method ?? 'GET') !== 'GET' && (
            <>
              {label('Body')}
              <textarea rows={3} className={input} value={String(c.body ?? '')} onChange={(e) => onChange({ body: e.target.value })} placeholder="{{input}}" />
            </>
          )}
          <p className="text-[11px] text-ink-600 mt-1">The response (status + body) becomes this step's output.</p>
        </>
      )}

      {kind === 'delay' && (
        <>
          {label('Wait (seconds)')}
          <input type="number" min={0} max={300} className={input} value={Number(c.seconds ?? 5)}
            onChange={(e) => onChange({ seconds: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })} />
          <p className="text-[11px] text-ink-600 mt-2">Pauses the workflow, then passes the input through unchanged.</p>
        </>
      )}

      {kind === 'trigger.webhook' && (() => {
        const event = String(c.event ?? '').trim();
        const url = webhookUrl ? (event ? `${webhookUrl}/${encodeURIComponent(event)}` : webhookUrl) : '';
        return (
          <>
            {label('Event name (optional)')}
            <input className={input} value={String(c.event ?? '')} onChange={(e) => onChange({ event: e.target.value })} placeholder="e.g. new-order (blank = any call)" />
            <p className="text-[11px] text-ink-600 mt-1">Blank fires on every call to your webhook URL. Named events only fire when the caller targets that event.</p>
            {label('Your webhook URL (POST here to run this workflow)')}
            <div className="flex items-center gap-1">
              <input readOnly className={clsx(input, 'font-mono text-[11px]')} value={url || 'loading…'} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" onClick={() => url && navigator.clipboard.writeText(url).catch(() => {})}
                title="Copy URL" className="shrink-0 text-ink-400 hover:text-cream-200 px-1.5 py-1">⧉</button>
            </div>
            <p className="text-[11px] text-ink-600 mt-2">The POST body is passed to the next step as <code className="text-clay">{'{{input}}'}</code>.</p>
          </>
        );
      })()}

      {kind === 'workflow.run' && (
        <>
          {label('Workflow to run')}
          <select className={input} value={String(c.workflowId ?? '')}
            onChange={(e) => { const w = workflows.find((x) => x.id === e.target.value); onChange({ workflowId: e.target.value, workflowName: w?.name }); }}>
            <option value="">— pick —</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {workflows.length === 0 && <p className="text-[11px] text-ink-600 mt-1">No other workflows to run yet.</p>}
          <p className="text-[11px] text-ink-600 mt-2">Starts the chosen workflow in the background (fire-and-forget).</p>
        </>
      )}

      {kind.startsWith('trigger.') && kind !== 'trigger.schedule' && (
        <p className="text-xs text-ink-500">This trigger starts the workflow when you press Run.</p>
      )}
    </div>
  );
}
