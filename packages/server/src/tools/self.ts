import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool, getTool, type ToolContext } from './registry.js';

// First sentence of a tool's description, capped — keeps describe_self compact.
function brief(name: string): string {
  const t = getTool(name);
  if (!t) return '';
  return (t.description.split(/(?<=[.!?])\s/)[0] ?? t.description).slice(0, 90);
}
const PERSONA = (n: number) => (n < 20 ? 'professional' : n < 60 ? 'balanced' : n < 90 ? 'personable' : 'full personality');

registerTool({
  name: 'describe_self',
  description:
    'Learn about yourself: your identity, model, the exact tools you have and how to use each, and the other agents you can delegate to. Call this when unsure what you can do. (Read-only.)',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx: ToolContext) {
    const a = ctx.agent;
    const tools = (a.enabledTools as string[]) ?? [];
    const toolLines = tools.map((n) => `- ${n}: ${brief(n)}`).join('\n');

    const others = await prisma.agent.findMany({
      where: { serverId: ctx.serverId, id: { not: a.id }, enabled: true },
      select: { name: true, isManager: true, bio: true, systemPrompt: true },
      take: 30,
    });
    const roster = others.length
      ? others.map((o) => `- @${o.name.replace(/\s+/g, '')}${o.isManager ? ' (Manager)' : ''}: ${(o.bio || o.systemPrompt).replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
      : '(you are the only agent here)';

    return [
      `You are "${a.name}"${a.isManager ? ', the Manager of this workspace' : ''}. Model class: ${a.modelClass}, effort: ${a.effort}, persona: ${a.personality}/100 (${PERSONA(a.personality)}).`,
      '',
      'YOUR TOOLS — you know these best; use them precisely:',
      toolLines || '(none)',
      '',
      'OTHER AGENTS (delegate by @mentioning them):',
      roster,
      '',
      'Your full instructions are your system message above (read-only here). If you need a tool or capability you lack, use request_capability. If you want to improve your own instructions, use propose_self_improvement — the Commander approves both.',
    ].join('\n');
  },
});

registerTool({
  name: 'request_capability',
  description:
    'Ask the Commander for a tool, integration, or MCP server you need but do not have. This is the official way to gain new abilities — you cannot grant them to yourself. Explain what you need and why.',
  input_schema: {
    type: 'object',
    properties: {
      capability: { type: 'string', description: 'The tool/integration/permission you want' },
      reason: { type: 'string', description: 'Why you need it (what task it unblocks)' },
    },
    required: ['capability'],
  },
  summarize: (input) => `Requests capability: ${input.capability}`,
  async execute(input, ctx: ToolContext) {
    const capability = String(input.capability ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    if (!capability) return 'Describe the capability you need.';
    const server = await prisma.server.findUnique({ where: { id: ctx.serverId }, select: { ownerId: true } });
    const body = `${ctx.agent.name} requests: ${capability}${reason ? ` — ${reason}` : ''}`;

    if (ctx.channelId) {
      const message = await prisma.message.create({
        data: {
          serverId: ctx.serverId, channelId: ctx.channelId, senderType: 'AGENT', agentId: ctx.agent.id,
          contentType: 'CARD', content: `🙋 Capability request: ${capability}`,
          meta: { kind: 'capability_request', agentId: ctx.agent.id, capability, reason } as Prisma.InputJsonValue,
          runId: ctx.runId ?? undefined,
        },
      });
      bus.emit('message.created', { serverId: ctx.serverId, channelId: ctx.channelId, message: { ...message, agentName: ctx.agent.name, files: [] } });
    }
    if (server) bus.emit('notification', { userId: server.ownerId, notification: { userId: server.ownerId, serverId: ctx.serverId, kind: 'info', title: `${ctx.agent.name} wants a new capability`, body } });
    return `Requested "${capability}" from the Commander. You'll get it if they approve — continue with what you can do for now.`;
  },
});

registerTool({
  name: 'propose_self_improvement',
  description:
    'Propose a change to your OWN instructions/behavior (you cannot edit them directly). Describe the improvement; the Commander reviews and applies it. Use this to get better over time through the official channel.',
  input_schema: {
    type: 'object',
    properties: {
      improvement: { type: 'string', description: 'The change to your instructions/behavior you propose' },
      reason: { type: 'string', description: 'Why it would make you more effective' },
    },
    required: ['improvement'],
  },
  summarize: (input) => `Proposes self-improvement`,
  async execute(input, ctx: ToolContext) {
    const improvement = String(input.improvement ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    if (!improvement) return 'Describe the improvement you propose.';
    const server = await prisma.server.findUnique({ where: { id: ctx.serverId }, select: { ownerId: true } });

    if (ctx.channelId) {
      const message = await prisma.message.create({
        data: {
          serverId: ctx.serverId, channelId: ctx.channelId, senderType: 'AGENT', agentId: ctx.agent.id,
          contentType: 'CARD', content: `✨ Self-improvement proposal from ${ctx.agent.name}`,
          meta: { kind: 'self_improvement', agentId: ctx.agent.id, improvement, reason } as Prisma.InputJsonValue,
          runId: ctx.runId ?? undefined,
        },
      });
      bus.emit('message.created', { serverId: ctx.serverId, channelId: ctx.channelId, message: { ...message, agentName: ctx.agent.name, files: [] } });
    }
    if (server) bus.emit('notification', { userId: server.ownerId, notification: { userId: server.ownerId, serverId: ctx.serverId, kind: 'info', title: `${ctx.agent.name} proposes a self-improvement`, body: improvement.slice(0, 200) } });
    return `Proposed the improvement to the Commander for review. It takes effect only once they apply it.`;
  },
});
