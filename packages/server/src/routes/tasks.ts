import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { bus } from '../realtime/bus.js';
import { enqueueAgentRun } from '../agents/dispatch.js';

export const tasksRouter = Router({ mergeParams: true });

tasksRouter.use(requireAuth);
tasksRouter.use(requireServerMember());

// GET /servers/:serverId/tasks
tasksRouter.get('/', async (req, res, next) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { serverId: req.membership!.serverId },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignedAgentId: z.string().optional(),
  channelId: z.string().optional(),
  mode: z.enum(['manual', 'managed']).optional(),
});

// POST /servers/:serverId/tasks
tasksRouter.post('/', async (req, res, next) => {
  try {
    const body = createTaskSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const task = await prisma.task.create({
      data: {
        serverId: req.membership!.serverId,
        title: body.data.title,
        description: body.data.description ?? '',
        assignedAgentId: body.data.assignedAgentId,
        channelId: body.data.channelId,
        mode: body.data.mode ?? 'managed',
        createdBy: req.user!.id,
      },
    });

    bus.emit('task.updated', { serverId: req.membership!.serverId, task });

    // Enqueue: explicit agent or the server's Manager
    let agentId = body.data.assignedAgentId;
    if (!agentId) {
      const mgr = await prisma.agent.findFirst({
        where: { serverId: req.membership!.serverId, isManager: true, enabled: true },
      });
      agentId = mgr?.id;
    }

    if (agentId) {
      await enqueueAgentRun({
        serverId: req.membership!.serverId,
        agentId,
        trigger: 'task',
        channelId: body.data.channelId,
        taskId: task.id,
        hops: 0,
      });
    }

    return res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

const patchTaskSchema = z.object({
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'REVIEW', 'DONE', 'FAILED']).optional(),
  result: z.string().optional(),
  assignedAgentId: z.string().nullable().optional(),
});

// PATCH /servers/:serverId/tasks/:taskId
tasksRouter.patch('/:taskId', async (req, res, next) => {
  try {
    const body = patchTaskSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const task = await prisma.task.findFirst({
      where: { id: req.params.taskId, serverId: req.membership!.serverId },
    });
    if (!task) return res.status(404).json({ error: 'not found' });

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: body.data,
    });

    bus.emit('task.updated', { serverId: req.membership!.serverId, task: updated });
    return res.json({ task: updated });
  } catch (err) {
    next(err);
  }
});
