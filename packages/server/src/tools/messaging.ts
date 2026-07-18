import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool } from './registry.js';

// Post to a channel. Agent-to-agent @mentions in the content are picked up by
// the mention-chaining subscriber (respecting hop limits).
registerTool({
  name: 'send_channel_message',
  description:
    'Post a message to a channel. To hand off to another agent, @mention them. Keep agent-to-agent messages terse and structured.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      channel: { type: 'string', description: 'Optional channel name; defaults to the current channel' },
    },
    required: ['content'],
  },
  async execute(input, ctx) {
    let channelId = ctx.channelId ?? null;
    if (input.channel) {
      const ch = await prisma.channel.findFirst({
        where: { serverId: ctx.serverId, name: String(input.channel) },
      });
      if (ch) channelId = ch.id;
    }
    if (!channelId) return 'No channel to post to.';
    const message = await prisma.message.create({
      data: {
        serverId: ctx.serverId,
        channelId,
        senderType: 'AGENT',
        agentId: ctx.agent.id,
        content: String(input.content),
        runId: ctx.runId ?? undefined,
      },
    });
    bus.emit('message.created', { serverId: ctx.serverId, channelId, message });
    return 'Message posted.';
  },
});

// DM the Commander (server owner) from this agent.
registerTool({
  name: 'send_dm',
  description: "Send a direct message to the Commander (the server's owner).",
  input_schema: {
    type: 'object',
    properties: { content: { type: 'string' } },
    required: ['content'],
  },
  async execute(input, ctx) {
    let thread = await prisma.dmThread.findFirst({
      where: { serverId: ctx.serverId, userId: ctx.ownerUserId, agentId: ctx.agent.id },
    });
    if (!thread) {
      thread = await prisma.dmThread.create({
        data: { serverId: ctx.serverId, userId: ctx.ownerUserId, agentId: ctx.agent.id },
      });
    }
    const message = await prisma.message.create({
      data: {
        serverId: ctx.serverId,
        dmThreadId: thread.id,
        senderType: 'AGENT',
        agentId: ctx.agent.id,
        content: String(input.content),
        runId: ctx.runId ?? undefined,
      },
    });
    bus.emit('message.created', { serverId: ctx.serverId, dmThreadId: thread.id, message });
    bus.emit('notification', {
      userId: ctx.ownerUserId,
      notification: {
        userId: ctx.ownerUserId,
        serverId: ctx.serverId,
        kind: 'dm',
        title: `${ctx.agent.name} sent you a DM`,
        body: String(input.content).slice(0, 140),
      },
    });
    return 'DM sent.';
  },
});
