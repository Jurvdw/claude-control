import { Router } from 'express';
import { z } from 'zod';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { randomToken } from '../lib/crypto.js';

export const invitesRouter = Router();
export const publicInvitesRouter = Router();

// ── Create invite (admin) ────────────────────────────────────────────────────

const createInviteSchema = z.object({
  role: z.nativeEnum(MemberRole).default(MemberRole.MEMBER),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

invitesRouter.post(
  '/servers/:serverId/invites',
  requireAuth,
  requireServerMember(MemberRole.ADMIN),
  async (req, res, next) => {
    try {
      const body = createInviteSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid body' });

      const invite = await prisma.invite.create({
        data: {
          serverId: req.params.serverId,
          code: randomToken(12),
          role: body.data.role,
          createdById: req.user!.id,
          maxUses: body.data.maxUses,
          expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : undefined,
        },
      });
      return res.status(201).json({ invite });
    } catch (err) {
      next(err);
    }
  },
);

// ── Public invite preview ────────────────────────────────────────────────────

publicInvitesRouter.get('/:code', async (req, res, next) => {
  try {
    const invite = await prisma.invite.findUnique({
      where: { code: req.params.code },
      include: { server: { select: { name: true } } },
    });
    if (!invite) return res.status(404).json({ error: 'not found' });

    const valid =
      (!invite.expiresAt || invite.expiresAt > new Date()) &&
      (!invite.maxUses || invite.uses < invite.maxUses);

    return res.json({ server: { name: invite.server.name }, valid });
  } catch (err) {
    next(err);
  }
});

// ── Accept invite ────────────────────────────────────────────────────────────

publicInvitesRouter.post('/:code/accept', requireAuth, async (req, res, next) => {
  try {
    const invite = await prisma.invite.findUnique({
      where: { code: req.params.code },
      include: { server: true },
    });
    if (!invite) return res.status(404).json({ error: 'not found' });

    const valid =
      (!invite.expiresAt || invite.expiresAt > new Date()) &&
      (!invite.maxUses || invite.uses < invite.maxUses);

    if (!valid) return res.status(410).json({ error: 'invite expired or exhausted' });

    const userId = req.user!.id;
    const existing = await prisma.serverMember.findUnique({
      where: { serverId_userId: { serverId: invite.serverId, userId } },
    });

    if (!existing) {
      await prisma.$transaction([
        prisma.serverMember.create({
          data: { serverId: invite.serverId, userId, role: invite.role },
        }),
        prisma.invite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } }),
      ]);
    }

    return res.json({ server: invite.server });
  } catch (err) {
    next(err);
  }
});
