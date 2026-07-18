import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const searchRouter = Router({ mergeParams: true });

searchRouter.use(requireAuth);
searchRouter.use(requireServerMember());

// GET /servers/:serverId/search?q=…  — cross-entity search (messages, notes, tasks, agents, workflows)
searchRouter.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const serverId = req.membership!.serverId;
    if (q.length < 2) return res.json({ results: { messages: [], notes: [], tasks: [], agents: [], workflows: [] } });
    const ci = { contains: q, mode: 'insensitive' as const };

    const [messages, notes, tasks, agents, workflows] = await Promise.all([
      prisma.message.findMany({
        where: { serverId, content: ci, channelId: { not: null } },
        select: { id: true, content: true, channelId: true, createdAt: true, senderType: true, agent: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      prisma.brainNote.findMany({
        where: { serverId, OR: [{ title: ci }, { summary: ci }, { content: ci }] },
        select: { id: true, title: true, folder: true, summary: true },
        take: 10,
      }),
      prisma.task.findMany({
        where: { serverId, OR: [{ title: ci }, { description: ci }] },
        select: { id: true, title: true, status: true },
        take: 8,
      }),
      prisma.agent.findMany({
        where: { serverId, name: ci },
        select: { id: true, name: true, isManager: true },
        take: 8,
      }),
      prisma.workflow.findMany({
        where: { serverId, name: ci },
        select: { id: true, name: true },
        take: 8,
      }),
    ]);

    // Resolve channel names for message hits (small N).
    const channelIds = [...new Set(messages.map((m) => m.channelId).filter(Boolean) as string[])];
    const channels = channelIds.length
      ? await prisma.channel.findMany({ where: { id: { in: channelIds } }, select: { id: true, name: true } })
      : [];
    const channelName = new Map(channels.map((c) => [c.id, c.name]));

    return res.json({
      results: {
        messages: messages.map((m) => ({
          id: m.id,
          channelId: m.channelId,
          channelName: m.channelId ? channelName.get(m.channelId) ?? null : null,
          excerpt: m.content.slice(0, 160),
          who: m.senderType === 'AGENT' ? m.agent?.name ?? 'Agent' : m.senderType === 'USER' ? 'You' : 'System',
          createdAt: m.createdAt,
        })),
        notes,
        tasks,
        agents: agents.map((a) => ({ id: a.id, name: a.name, description: a.isManager ? 'manager' : 'agent' })),
        workflows,
      },
    });
  } catch (err) {
    next(err);
  }
});
