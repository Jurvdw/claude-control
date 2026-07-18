import { Router } from 'express';
import { z } from 'zod';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const channelsRouter = Router({ mergeParams: true });

channelsRouter.use(requireAuth);

// GET /servers/:serverId/channels
channelsRouter.get('/', requireServerMember(), async (req, res, next) => {
  try {
    const channels = await prisma.channel.findMany({
      where: { serverId: req.params.serverId },
      orderBy: { position: 'asc' },
      select: { id: true, name: true, topic: true, isDefault: true, position: true },
    });
    return res.json({ channels });
  } catch (err) {
    next(err);
  }
});

const createChannelSchema = z.object({
  name: z.string().min(1),
  topic: z.string().optional(),
});

// POST /servers/:serverId/channels
channelsRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = createChannelSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const max = await prisma.channel.aggregate({
      where: { serverId: req.params.serverId },
      _max: { position: true },
    });
    const position = (max._max.position ?? -1) + 1;

    const channel = await prisma.channel.create({
      data: {
        serverId: req.params.serverId,
        name: body.data.name,
        topic: body.data.topic ?? '',
        position,
      },
    });
    return res.status(201).json({ channel });
  } catch (err) {
    next(err);
  }
});

const patchChannelSchema = z.object({
  name: z.string().min(1).optional(),
  topic: z.string().optional(),
});

// PATCH /servers/:serverId/channels/:channelId
channelsRouter.patch('/:channelId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = patchChannelSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const channel = await prisma.channel.findFirst({
      where: { id: req.params.channelId, serverId: req.params.serverId },
    });
    if (!channel) return res.status(404).json({ error: 'not found' });

    const updated = await prisma.channel.update({
      where: { id: channel.id },
      data: {
        ...(body.data.name && { name: body.data.name }),
        ...(body.data.topic !== undefined && { topic: body.data.topic }),
      },
    });
    return res.json({ channel: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /servers/:serverId/channels/:channelId
channelsRouter.delete('/:channelId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const channel = await prisma.channel.findFirst({
      where: { id: req.params.channelId, serverId: req.params.serverId },
    });
    if (!channel) return res.status(404).json({ error: 'not found' });

    await prisma.channel.delete({ where: { id: channel.id } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
