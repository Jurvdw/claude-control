import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const activityRouter = Router({ mergeParams: true });

activityRouter.use(requireAuth);
activityRouter.use(requireServerMember());

// GET /servers/:serverId/activity?before=<iso>&agentId=&status=&limit=
// A timeline of agent runs (newest first) with tools, tokens, cost, duration.
activityRouter.get('/', async (req, res, next) => {
  try {
    const serverId = req.membership!.serverId;
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const before = req.query.before as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const status = req.query.status as string | undefined;

    const runs = await prisma.run.findMany({
      where: {
        serverId,
        ...(before && { createdAt: { lt: new Date(before) } }),
        ...(agentId && { agentId }),
        ...(status && { status }),
      },
      select: {
        id: true, agentId: true, trigger: true, model: true, status: true, error: true,
        inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true,
        costUsd: true, durationMs: true, tools: true, channelId: true, taskId: true, createdAt: true,
        agent: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return res.json({
      runs: runs.map((r) => {
        const { agent, ...rest } = r;
        return { ...rest, agentName: agent?.name ?? 'Agent' };
      }),
    });
  } catch (err) {
    next(err);
  }
});
