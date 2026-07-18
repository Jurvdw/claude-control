import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool } from './registry.js';
import { runWorkflow, type WFNode, type WFEdge } from '../workflows/engine.js';

// Compile an agent-friendly linear step list into a node/edge graph the engine
// runs. Steps chain: trigger → step1 → step2 → … (each step gets {{input}} =
// the previous step's output).
interface StepSpec {
  type: 'agent' | 'post' | 'brain';
  agent?: string; // agent name (for type 'agent')
  prompt?: string;
  channel?: string; // channel name (for type 'post')
  text?: string;
  title?: string; // brain note
  folder?: string;
  content?: string;
}

async function compileGraph(
  serverId: string,
  steps: StepSpec[],
  schedule?: string,
): Promise<{ nodes: WFNode[]; edges: WFEdge[] }> {
  const [agents, channels] = await Promise.all([
    prisma.agent.findMany({ where: { serverId }, select: { id: true, name: true } }),
    prisma.channel.findMany({ where: { serverId }, select: { id: true, name: true } }),
  ]);
  const agentByName = (n?: string) =>
    agents.find((a) => a.name.toLowerCase() === (n ?? '').toLowerCase())?.id ?? agents[0]?.id;
  const channelByName = (n?: string) =>
    channels.find((c) => c.name.toLowerCase() === (n ?? '').replace(/^#/, '').toLowerCase())?.id ??
    channels[0]?.id;

  const nodes: WFNode[] = [];
  const edges: WFEdge[] = [];
  const trigger: WFNode = {
    id: 'trigger',
    type: schedule ? 'trigger.schedule' : 'trigger.manual',
    position: { x: 80, y: 80 },
    data: schedule ? { cron: schedule } : {},
  };
  nodes.push(trigger);

  let prevId = trigger.id;
  steps.forEach((s, i) => {
    const id = `n${i + 1}`;
    const position = { x: 80 + (i + 1) * 260, y: 80 };
    let node: WFNode;
    // No silent catch-all. This used to be `else -> brain.write`, so a step
    // with a missing or misspelled type quietly became an "Untitled" Brain
    // write: a request for "summarise the Brain and post it to #general" built
    // two brain.writes and no channel.post, the tool reported success, and the
    // agent told the Commander it had wired up a post it had not. A wrong
    // workflow that claims to work is worse than a rejected one.
    if (s.type === 'agent') {
      node = { id, type: 'agent.run', position, data: { agentId: agentByName(s.agent), prompt: s.prompt ?? '{{input}}' } };
    } else if (s.type === 'post') {
      node = { id, type: 'channel.post', position, data: { channelId: channelByName(s.channel), text: s.text ?? '{{input}}' } };
    } else if (s.type === 'brain') {
      node = { id, type: 'brain.write', position, data: { title: s.title ?? 'Untitled', folder: s.folder ?? '', content: s.content ?? '{{input}}' } };
    } else {
      throw new Error(
        `step ${i + 1} has type "${s.type ?? '(missing)'}" — must be "agent" (run an agent), "post" (post to a channel) or "brain" (write a Brain note). ` +
          'To summarise something, use an "agent" step with a prompt, then a "post" step to publish the result.',
      );
    }
    nodes.push(node);
    edges.push({ id: `${prevId}-${id}`, source: prevId, target: id });
    prevId = id;
  });

  return { nodes, edges };
}

registerTool({
  name: 'create_workflow',
  description:
    'Create an automation workflow: steps run in sequence, each getting the previous output as {{input}}. Optional cron schedule. Steps: {type:"agent",agent,prompt} | {type:"post",channel,text} | {type:"brain",title,content}.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      schedule: { type: 'string', description: 'Optional cron expression (e.g. "0 9 * * *" for 9am daily)' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['agent', 'post', 'brain'] },
            agent: { type: 'string' },
            prompt: { type: 'string' },
            channel: { type: 'string' },
            text: { type: 'string' },
            title: { type: 'string' },
            folder: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['type'],
        },
      },
    },
    required: ['name', 'steps'],
  },
  summarize: (input) => `Create workflow "${input.name}"`,
  async execute(input, ctx) {
    const steps = (input.steps as StepSpec[]) ?? [];
    if (steps.length === 0) return 'A workflow needs at least one step.';
    const graph = await compileGraph(ctx.serverId, steps, input.schedule ? String(input.schedule) : undefined);
    const workflow = await prisma.workflow.create({
      data: {
        serverId: ctx.serverId,
        name: String(input.name),
        graph: graph as unknown as Prisma.InputJsonValue,
        createdBy: ctx.agent.id,
      },
    });
    bus.emit('workflow.updated', { serverId: ctx.serverId, workflow });
    return `Created workflow "${workflow.name}" with ${steps.length} step(s)${input.schedule ? `, scheduled (${input.schedule})` : ''}. ID: ${workflow.id}`;
  },
});

registerTool({
  name: 'list_workflows',
  description: 'List this workspace\'s automation workflows (name, enabled, schedule).',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    const workflows = await prisma.workflow.findMany({
      where: { serverId: ctx.serverId },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
    if (workflows.length === 0) return 'No workflows yet.';
    return workflows
      .map((w) => {
        const graph = (w.graph ?? {}) as { nodes?: { type: string; data?: { cron?: string } }[] };
        const cron = graph.nodes?.find((n) => n.type === 'trigger.schedule')?.data?.cron;
        return `- ${w.name} [${w.enabled ? 'on' : 'off'}]${cron ? ` cron:${cron}` : ''} — ${graph.nodes?.length ?? 0} nodes (id: ${w.id})`;
      })
      .join('\n');
  },
});

registerTool({
  name: 'run_workflow',
  description: 'Run an automation workflow now, by name or id.',
  input_schema: {
    type: 'object',
    properties: { workflow: { type: 'string', description: 'Workflow name or id' } },
    required: ['workflow'],
  },
  summarize: (input) => `Run workflow "${input.workflow}"`,
  async execute(input, ctx) {
    const q = String(input.workflow);
    const workflow = await prisma.workflow.findFirst({
      where: { serverId: ctx.serverId, OR: [{ id: q }, { name: { equals: q, mode: 'insensitive' } }] },
    });
    if (!workflow) return `No workflow named "${q}".`;
    try {
      await runWorkflow(workflow.id, { trigger: 'agent' });
      return `Started workflow "${workflow.name}". It runs in the background; check the Workflows tab for the result.`;
    } catch (err) {
      return `Couldn't run "${workflow.name}": ${(err as Error).message}`;
    }
  },
});
