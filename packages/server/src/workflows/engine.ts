import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { logger } from '../lib/logger.js';
import { runAgent } from '../agents/runLoop.js';

// ─── Graph shape (stored as JSON on Workflow.graph) ──────────────────────────
// Deliberately loose so the GUI canvas and agent tools can both write it.

export interface WFNode {
  id: string;
  type: string; // 'trigger.manual' | 'trigger.schedule' | 'agent.run' | 'channel.post' | 'brain.write' | 'condition'
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
}
export interface WFEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null; // for condition nodes: 'true' | 'false'
}
export interface WFGraph {
  nodes: WFNode[];
  edges: WFEdge[];
}

export interface WFLogEntry {
  nodeId: string;
  type: string;
  status: 'ok' | 'error' | 'skipped';
  output?: string;
  error?: string;
}

export const NODE_TYPES = [
  'trigger.manual',
  'trigger.schedule',
  'trigger.webhook',
  'agent.run',
  'channel.post',
  'brain.write',
  'condition',
  'http.request',
  'delay',
  'workflow.run',
] as const;

const MAX_NODES = 60;

function edgeKey(e: WFEdge): string {
  return e.id ?? `${e.source}->${e.target}#${e.sourceHandle ?? ''}`;
}

// Kahn topological order. Returns null if the graph has a cycle.
export function topoOrder(nodes: WFNode[], edges: WFEdge[]): string[] | null {
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) if (indeg.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const q = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    order.push(id);
    for (const e of edges.filter((e) => e.source === id)) {
      indeg.set(e.target, (indeg.get(e.target) ?? 1) - 1);
      if ((indeg.get(e.target) ?? 0) === 0) q.push(e.target);
    }
  }
  return order.length === nodes.length ? order : null;
}

/** Kick off a workflow run. Returns the created run record immediately; the
 *  graph executes in the background and streams status over the bus.
 *  `input` seeds the entry node's output (e.g. a webhook request body);
 *  `entryType` forces which trigger node the run starts from. */
export async function runWorkflow(
  workflowId: string,
  opts?: { trigger?: string; input?: string; entryType?: string },
): Promise<{ id: string; status: string }> {
  const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!wf) throw new Error('Workflow not found');
  if (!wf.enabled) throw new Error('Workflow is disabled');

  const run = await prisma.workflowRun.create({
    data: { workflowId: wf.id, serverId: wf.serverId, trigger: opts?.trigger ?? 'manual', status: 'running' },
  });
  bus.emit('workflow.run', { serverId: wf.serverId, workflowId: wf.id, run });

  // Execute in the background so callers (HTTP/agent tool) return promptly.
  void executeGraph(wf.id, wf.serverId, (wf.graph ?? {}) as unknown as WFGraph, run.id, {
    input: opts?.input,
    entryType: opts?.entryType,
  }).catch((err) => {
    logger.error('workflow execution crashed', { workflowId: wf.id, error: (err as Error).message });
  });

  return { id: run.id, status: 'running' };
}

async function executeGraph(
  workflowId: string,
  serverId: string,
  graph: WFGraph,
  runId: string,
  opts?: { input?: string; entryType?: string },
): Promise<void> {
  const nodes = (graph.nodes ?? []).slice(0, MAX_NODES);
  const edges = graph.edges ?? [];
  const log: WFLogEntry[] = [];
  const outputs = new Map<string, string>();
  let status: 'ok' | 'error' = 'ok';
  let runError: string | undefined;

  try {
    const order = topoOrder(nodes, edges);
    if (!order) throw new Error('Workflow graph has a cycle');

    // Entry point: the requested trigger type (e.g. trigger.webhook), else the
    // manual trigger, else any trigger node.
    const preferred = opts?.entryType ?? 'trigger.manual';
    const start =
      nodes.find((n) => n.type === preferred) ?? nodes.find((n) => n.type.startsWith('trigger.'));
    if (!start) throw new Error('Workflow has no trigger node');

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const activeNodes = new Set<string>([start.id]);
    const activeEdges = new Set<string>();

    for (const id of order) {
      const node = nodeById.get(id);
      if (!node) continue;
      if (!activeNodes.has(id)) {
        // Only log skips for real (non-trigger) nodes to avoid noise.
        if (!node.type.startsWith('trigger.')) log.push({ nodeId: id, type: node.type, status: 'skipped' });
        continue;
      }

      const incoming = edges.filter((e) => e.target === id && activeEdges.has(edgeKey(e)));
      // The entry node is seeded with the run's initial input (e.g. webhook body).
      const input = id === start.id
        ? (opts?.input ?? '')
        : incoming.map((e) => outputs.get(e.source) ?? '').filter(Boolean).join('\n\n');

      let output = '';
      let condResult: boolean | undefined;
      try {
        const r = await execNode(node, input, serverId);
        output = r.output;
        condResult = r.condResult;
        log.push({ nodeId: id, type: node.type, status: 'ok', output: output.slice(0, 2000) });
      } catch (err) {
        log.push({ nodeId: id, type: node.type, status: 'error', error: (err as Error).message.slice(0, 500) });
        throw err; // fail the whole run on the first node error
      }
      outputs.set(id, output);

      // Activate downstream edges (condition nodes only follow the matching branch).
      for (const e of edges.filter((e) => e.source === id)) {
        if (node.type === 'condition') {
          const want = condResult ? 'true' : 'false';
          if ((e.sourceHandle ?? 'true') !== want) continue;
        }
        activeEdges.add(edgeKey(e));
        activeNodes.add(e.target);
      }

      // Stream progress after each node.
      await persist(runId, serverId, workflowId, 'running', log, undefined);
    }
  } catch (err) {
    status = 'error';
    runError = (err as Error).message;
  }

  await prisma.workflow.update({ where: { id: workflowId }, data: { lastRunAt: new Date() } }).catch(() => {});
  await persist(runId, serverId, workflowId, status, log, runError, true);
}

async function persist(
  runId: string,
  serverId: string,
  workflowId: string,
  status: string,
  log: WFLogEntry[],
  error: string | undefined,
  final = false,
): Promise<void> {
  const run = await prisma.workflowRun.update({
    where: { id: runId },
    data: {
      status,
      log: log as unknown as Prisma.InputJsonValue,
      error: error ?? null,
      ...(final ? { finishedAt: new Date() } : {}),
    },
  });
  bus.emit('workflow.run', { serverId, workflowId, run });
}

// Interpolate {{input}} (and {{output}}) references in a template string.
function tpl(s: unknown, input: string): string {
  return String(s ?? '').replace(/\{\{\s*(input|output)\s*\}\}/gi, input);
}

async function execNode(
  node: WFNode,
  input: string,
  serverId: string,
): Promise<{ output: string; condResult?: boolean }> {
  const d = node.data ?? {};
  switch (node.type) {
    case 'trigger.manual':
    case 'trigger.schedule':
    case 'trigger.webhook':
      return { output: input };

    case 'agent.run': {
      const agentId = String(d.agentId ?? '');
      if (!agentId) throw new Error('agent.run node is missing an agent');
      const prompt = tpl(d.prompt, input) || input || 'Proceed with your task.';
      const text = await runAgent({ serverId, agentId, trigger: 'manual', prompt }, { capture: true });
      return { output: typeof text === 'string' ? text : '' };
    }

    case 'channel.post': {
      const channelId = String(d.channelId ?? '');
      if (!channelId) throw new Error('channel.post node is missing a channel');
      const content = tpl(d.text ?? '{{input}}', input).trim() || '(empty)';
      const message = await prisma.message.create({
        data: { serverId, channelId, senderType: 'SYSTEM', content },
      });
      bus.emit('message.created', { serverId, channelId, message });
      return { output: content };
    }

    case 'brain.write': {
      const title = String(d.title ?? 'Untitled');
      const folder = String(d.folder ?? '');
      const summary = String(d.summary ?? '');
      const content = tpl(d.content ?? '{{input}}', input);
      const existing = await prisma.brainNote.findFirst({ where: { serverId, title, folder }, select: { id: true } });
      const note = existing
        ? await prisma.brainNote.update({ where: { id: existing.id }, data: { summary, content } })
        : await prisma.brainNote.create({ data: { serverId, title, folder, summary, content } });
      bus.emit('brain.updated', { serverId, note });
      return { output: `Wrote Brain note "${title}"` };
    }

    case 'condition': {
      const mode = String(d.mode ?? 'notEmpty');
      const value = String(d.value ?? '');
      let res: boolean;
      if (mode === 'contains') res = input.toLowerCase().includes(value.toLowerCase());
      else if (mode === 'equals') res = input.trim() === value.trim();
      else res = input.trim().length > 0;
      return { output: input, condResult: res };
    }

    case 'http.request': {
      const method = String(d.method ?? 'GET').toUpperCase();
      const url = tpl(d.url, input).trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('http.request needs an http(s) URL');
      let headers: Record<string, string> = {};
      try {
        if (d.headers) headers = typeof d.headers === 'string' ? JSON.parse(d.headers) : (d.headers as Record<string, string>);
      } catch {
        /* ignore malformed headers */
      }
      const init: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'HEAD') init.body = tpl(d.body ?? '{{input}}', input);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        const text = await res.text();
        return { output: `HTTP ${res.status}\n${text.slice(0, 8000)}` };
      } finally {
        clearTimeout(timer);
      }
    }

    case 'delay': {
      const secs = Math.max(0, Math.min(Number(d.seconds) || 0, 300));
      if (secs > 0) await new Promise((r) => setTimeout(r, secs * 1000));
      return { output: input };
    }

    case 'workflow.run': {
      const targetId = String(d.workflowId ?? '');
      if (!targetId) throw new Error('workflow.run node is missing a target workflow');
      if (targetId === node.id) throw new Error('workflow.run cannot target itself');
      const target = await prisma.workflow.findFirst({ where: { id: targetId, serverId }, select: { id: true, name: true, enabled: true } });
      if (!target) throw new Error('Target workflow not found');
      if (!target.enabled) throw new Error(`Target workflow "${target.name}" is disabled`);
      // Fire-and-forget: the sub-workflow runs on its own; we don't block or chain its output.
      const sub = await runWorkflow(target.id, { trigger: 'sub-workflow' });
      return { output: `Started sub-workflow "${target.name}" (run ${sub.id})` };
    }

    default:
      throw new Error(`Unknown node type "${node.type}"`);
  }
}
