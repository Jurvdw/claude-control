import { Router } from 'express';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { getTool } from '../tools/index.js';
import { bus } from '../realtime/bus.js';

export const approvalsRouter = Router({ mergeParams: true });

approvalsRouter.use(requireAuth);
approvalsRouter.use(requireServerMember());

// GET /servers/:serverId/approvals?status=PENDING
approvalsRouter.get('/', async (req, res, next) => {
  try {
    const status = (req.query.status as string) || 'PENDING';
    const approvals = await prisma.approval.findMany({
      where: {
        serverId: req.membership!.serverId,
        ...(status && { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' }),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, action: true, summary: true, payload: true, status: true, createdAt: true },
    });
    return res.json({ approvals });
  } catch (err) {
    next(err);
  }
});

// POST /servers/:serverId/approvals/:id/approve
approvalsRouter.post('/:id/approve', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const approval = await prisma.approval.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!approval) return res.status(404).json({ error: 'not found' });
    if (approval.status !== 'PENDING') return res.status(409).json({ error: 'not pending' });

    // Execute the tool
    const tool = getTool(approval.action);
    if (tool) {
      const payload = approval.payload as {
        input?: Record<string, unknown>;
        channelId?: string;
        taskId?: string;
      };

      const server = await prisma.server.findUnique({ where: { id: req.membership!.serverId } });
      const agent = approval.agentId
        ? await prisma.agent.findUnique({ where: { id: approval.agentId } })
        : null;

      if (server && agent) {
        try {
          await tool.execute(payload.input ?? {}, {
            serverId: server.id,
            agent,
            ownerUserId: server.ownerId,
            channelId: payload.channelId,
            taskId: payload.taskId,
            runId: approval.runId,
          });
        } catch {
          // execution errors don't block the approval update
        }
      }
    }

    const updated = await prisma.approval.update({
      where: { id: approval.id },
      data: { status: 'APPROVED', decidedBy: req.user!.id, decidedAt: new Date() },
    });

    bus.emit('approval.updated', { serverId: req.membership!.serverId, approval: updated });
    return res.json({ approval: updated });
  } catch (err) {
    next(err);
  }
});

// POST /servers/:serverId/approvals/:id/reject
approvalsRouter.post('/:id/reject', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const approval = await prisma.approval.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!approval) return res.status(404).json({ error: 'not found' });

    const updated = await prisma.approval.update({
      where: { id: approval.id },
      data: { status: 'REJECTED', decidedBy: req.user!.id, decidedAt: new Date() },
    });

    bus.emit('approval.updated', { serverId: req.membership!.serverId, approval: updated });
    return res.json({ approval: updated });
  } catch (err) {
    next(err);
  }
});
