import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const plansRouter = Router({ mergeParams: true });

plansRouter.use(requireAuth);
plansRouter.use(requireServerMember());

// GET /servers/:serverId/plans?status=active — recent plans with their steps.
plansRouter.get('/', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const plans = await prisma.plan.findMany({
      where: { serverId: req.membership!.serverId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    return res.json({ plans });
  } catch (err) {
    next(err);
  }
});

// GET /servers/:serverId/plans/:id
plansRouter.get('/:id', async (req, res, next) => {
  try {
    const plan = await prisma.plan.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    if (!plan) return res.status(404).json({ error: 'not found' });
    return res.json({ plan });
  } catch (err) {
    next(err);
  }
});
