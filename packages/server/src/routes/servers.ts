import { Router } from 'express';
import { z } from 'zod';
import { MemberRole, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const serversRouter = Router();

serversRouter.use(requireAuth);

// ── List user's servers ──────────────────────────────────────────────────────

serversRouter.get('/', async (req, res, next) => {
  try {
    const memberships = await prisma.serverMember.findMany({
      where: { userId: req.user!.id },
      include: { server: true },
      orderBy: { createdAt: 'asc' },
    });
    const servers = memberships.map((m) => ({
      id: m.server.id,
      name: m.server.name,
      description: m.server.description,
      iconUrl: m.server.iconUrl,
      role: m.role,
    }));
    return res.json({ servers });
  } catch (err) {
    next(err);
  }
});

// ── Create server ────────────────────────────────────────────────────────────

const createServerSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

serversRouter.post('/', async (req, res, next) => {
  try {
    const body = createServerSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const { name, description } = body.data;
    const userId = req.user!.id;

    const server = await prisma.$transaction(async (tx) => {
      const s = await tx.server.create({
        data: {
          name,
          description: description ?? '',
          ownerId: userId,
          settings: {
            brainWritePolicy: 'direct',
            approvalMode: false,
            approvalActions: [],
            hopLimit: 4,
            maxConcurrent: 5,
            proactiveDefault: false,
          },
        },
      });

      // Owner membership
      await tx.serverMember.create({
        data: { serverId: s.id, userId, role: MemberRole.OWNER },
      });

      // Default channel
      await tx.channel.create({
        data: { serverId: s.id, name: 'general', isDefault: true, position: 0 },
      });

      // Optional Manager agent from template
      const mgr = await tx.agentTemplate.findFirst({ where: { isManager: true } });
      if (mgr) {
        await tx.agent.create({
          data: {
            serverId: s.id,
            name: mgr.name,
            avatarUrl: mgr.avatarUrl,
            bio: mgr.description,
            systemPrompt: mgr.systemPrompt,
            modelClass: mgr.modelClass,
            effort: mgr.effort,
            enabledTools: mgr.enabledTools as Prisma.InputJsonValue,
            isManager: true,
          },
        });
      }

      return s;
    });

    return res.status(201).json({ server });
  } catch (err) {
    next(err);
  }
});

// ── Get server ───────────────────────────────────────────────────────────────

serversRouter.get(
  '/:serverId',
  requireServerMember(),
  async (req, res, next) => {
    try {
      const server = await prisma.server.findUnique({ where: { id: req.params.serverId } });
      if (!server) return res.status(404).json({ error: 'server not found' });

      const members = await prisma.serverMember.findMany({
        where: { serverId: server.id },
        include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
      });

      return res.json({
        server,
        members: members.map((m) => ({
          userId: m.userId,
          displayName: m.user.displayName,
          avatarUrl: m.user.avatarUrl,
          role: m.role,
        })),
        settings: server.settings,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── Update server ────────────────────────────────────────────────────────────

const patchServerSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

serversRouter.patch(
  '/:serverId',
  requireServerMember(MemberRole.ADMIN),
  async (req, res, next) => {
    try {
      const body = patchServerSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid body' });

      const server = await prisma.server.findUnique({ where: { id: req.params.serverId } });
      if (!server) return res.status(404).json({ error: 'not found' });

      const updated = await prisma.server.update({
        where: { id: req.params.serverId },
        data: {
          ...(body.data.name && { name: body.data.name }),
          ...(body.data.description !== undefined && { description: body.data.description }),
          ...(body.data.settings && {
            settings: { ...(server.settings as object), ...body.data.settings } as Prisma.InputJsonValue,
          }),
        },
      });

      return res.json({ server: updated });
    } catch (err) {
      next(err);
    }
  },
);

// ── Delete server ────────────────────────────────────────────────────────────

serversRouter.delete(
  '/:serverId',
  requireServerMember(MemberRole.OWNER),
  async (req, res, next) => {
    try {
      await prisma.server.delete({ where: { id: req.params.serverId } });
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ── Pause / resume all agents ────────────────────────────────────────────────

serversRouter.post(
  '/:serverId/pause-all',
  requireServerMember(MemberRole.ADMIN),
  async (req, res, next) => {
    try {
      await prisma.agent.updateMany({
        where: { serverId: req.params.serverId },
        data: { status: 'PAUSED', enabled: false },
      });
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

serversRouter.post(
  '/:serverId/resume-all',
  requireServerMember(MemberRole.ADMIN),
  async (req, res, next) => {
    try {
      await prisma.agent.updateMany({
        where: { serverId: req.params.serverId },
        data: { status: 'IDLE', enabled: true },
      });
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
