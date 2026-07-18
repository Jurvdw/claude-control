import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const reactionsRouter = Router({ mergeParams: true });

reactionsRouter.use(requireAuth);
reactionsRouter.use(requireServerMember());

const reactionSchema = z.object({
  kind: z.enum(['up', 'down']),
  feedback: z.string().optional(),
});

// POST /servers/:serverId/messages/:messageId/reactions
reactionsRouter.post('/', async (req, res, next) => {
  try {
    const body = reactionSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    // Verify message belongs to this server
    const message = await prisma.message.findFirst({
      where: { id: (req.params as Record<string, string>).messageId, serverId: req.membership!.serverId },
    });
    if (!message) return res.status(404).json({ error: 'message not found' });

    const reaction = await prisma.reaction.upsert({
      where: {
        messageId_userId_kind: {
          messageId: (req.params as Record<string, string>).messageId,
          userId: req.user!.id,
          kind: body.data.kind,
        },
      },
      create: {
        messageId: (req.params as Record<string, string>).messageId,
        userId: req.user!.id,
        kind: body.data.kind,
        feedback: body.data.feedback,
      },
      update: { feedback: body.data.feedback },
    });

    // On thumbs-down with feedback: store a correction memory for the agent.
    if (body.data.kind === 'down' && body.data.feedback && message.agentId) {
      await prisma.memory.create({
        data: {
          agentId: message.agentId,
          serverId: req.membership!.serverId,
          key: `correction:${Date.now()}`,
          content: body.data.feedback,
        },
      });
    }

    return res.status(201).json({ reaction });
  } catch (err) {
    next(err);
  }
});

// DELETE /servers/:serverId/messages/:messageId/reactions/:kind
reactionsRouter.delete('/:kind', async (req, res, next) => {
  try {
    const message = await prisma.message.findFirst({
      where: { id: (req.params as Record<string, string>).messageId, serverId: req.membership!.serverId },
    });
    if (!message) return res.status(404).json({ error: 'message not found' });

    await prisma.reaction
      .delete({
        where: {
          messageId_userId_kind: {
            messageId: (req.params as Record<string, string>).messageId,
            userId: req.user!.id,
            kind: req.params.kind,
          },
        },
      })
      .catch(() => {}); // ignore if not found

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
