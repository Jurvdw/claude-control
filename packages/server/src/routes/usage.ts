import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const usageRouter = Router({ mergeParams: true });
export const globalUsageRouter = Router();

usageRouter.use(requireAuth);
globalUsageRouter.use(requireAuth);

// GET /servers/:serverId/usage?from&to
usageRouter.get('/', requireServerMember(), async (req, res, next) => {
  try {
    const serverId = req.params.serverId;
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 30 * 86400000);
    const to = req.query.to ? new Date(req.query.to as string) : new Date();

    const runs = await prisma.run.findMany({
      where: { serverId, createdAt: { gte: from, lte: to } },
      include: { agent: { select: { name: true } } },
    });

    const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
    const totalRuns = runs.length;

    // Cost over time (by day)
    const byDay = new Map<string, number>();
    for (const r of runs) {
      const day = r.createdAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + r.costUsd);
    }
    const costOverTime = [...byDay.entries()].map(([date, cost]) => ({ date, cost })).sort((a, b) => a.date.localeCompare(b.date));

    // Per agent
    const byAgent = new Map<string, { agentName: string; cost: number; runs: number }>();
    for (const r of runs) {
      if (!r.agentId) continue;
      const entry = byAgent.get(r.agentId) ?? { agentName: r.agent?.name ?? 'Unknown', cost: 0, runs: 0 };
      entry.cost += r.costUsd;
      entry.runs += 1;
      byAgent.set(r.agentId, entry);
    }
    const perAgent = [...byAgent.entries()].map(([agentId, v]) => ({ agentId, ...v }));

    // Tokens by model
    const byModel = new Map<string, { input: number; output: number }>();
    for (const r of runs) {
      const m = r.model || 'unknown';
      const entry = byModel.get(m) ?? { input: 0, output: 0 };
      entry.input += r.inputTokens;
      entry.output += r.outputTokens;
      byModel.set(m, entry);
    }
    const tokensByModel = [...byModel.entries()].map(([model, v]) => ({ model, ...v }));

    // Top tasks by cost
    const byTask = new Map<string, { cost: number }>();
    for (const r of runs) {
      if (!r.taskId) continue;
      const entry = byTask.get(r.taskId) ?? { cost: 0 };
      entry.cost += r.costUsd;
      byTask.set(r.taskId, entry);
    }
    const taskIds = [...byTask.keys()];
    const tasks = taskIds.length
      ? await prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } })
      : [];
    const taskMap = new Map(tasks.map((t) => [t.id, t.title]));
    const topTasks = [...byTask.entries()]
      .map(([taskId, v]) => ({ taskId, title: taskMap.get(taskId) ?? '', cost: v.cost }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);

    return res.json({ totalCost, totalRuns, costOverTime, perAgent, tokensByModel, topTasks });
  } catch (err) {
    next(err);
  }
});

// GET /usage — across all the user's servers
globalUsageRouter.get('/', async (req, res, next) => {
  try {
    const memberships = await prisma.serverMember.findMany({
      where: { userId: req.user!.id },
      include: { server: { select: { id: true, name: true } } },
    });

    const perServer: { serverId: string; name: string; cost: number }[] = [];

    for (const m of memberships) {
      const agg = await prisma.run.aggregate({
        where: { serverId: m.server.id },
        _sum: { costUsd: true },
      });
      perServer.push({ serverId: m.server.id, name: m.server.name, cost: agg._sum.costUsd ?? 0 });
    }

    return res.json({ perServer });
  } catch (err) {
    next(err);
  }
});
