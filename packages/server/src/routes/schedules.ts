import { Router } from 'express';
import { z } from 'zod';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const schedulesRouter = Router({ mergeParams: true });

schedulesRouter.use(requireAuth);
schedulesRouter.use(requireServerMember());

schedulesRouter.get('/', async (req, res, next) => {
  try {
    const schedules = await prisma.schedule.findMany({
      where: { serverId: req.membership!.serverId },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ schedules });
  } catch (err) {
    next(err);
  }
});

const scheduleSchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  agentId: z.string().optional(),
  channelId: z.string().optional(),
  enabled: z.boolean().optional(),
});

schedulesRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = scheduleSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const schedule = await prisma.schedule.create({
      data: { serverId: req.membership!.serverId, ...body.data },
    });
    return res.status(201).json({ schedule });
  } catch (err) {
    next(err);
  }
});

const patchScheduleSchema = scheduleSchema.partial();

schedulesRouter.patch('/:scheduleId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = patchScheduleSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const s = await prisma.schedule.findFirst({
      where: { id: req.params.scheduleId, serverId: req.membership!.serverId },
    });
    if (!s) return res.status(404).json({ error: 'not found' });

    const schedule = await prisma.schedule.update({
      where: { id: s.id },
      data: body.data,
    });
    return res.json({ schedule });
  } catch (err) {
    next(err);
  }
});

schedulesRouter.delete('/:scheduleId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const s = await prisma.schedule.findFirst({
      where: { id: req.params.scheduleId, serverId: req.membership!.serverId },
    });
    if (!s) return res.status(404).json({ error: 'not found' });

    await prisma.schedule.delete({ where: { id: s.id } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
