import { Router } from 'express';
import { z } from 'zod';
import { MemberRole, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { bus } from '../realtime/bus.js';
import { runWorkflow } from '../workflows/engine.js';

export const workflowsRouter = Router({ mergeParams: true });

workflowsRouter.use(requireAuth);
workflowsRouter.use(requireServerMember());

// GET /servers/:serverId/workflows
workflowsRouter.get('/', async (req, res, next) => {
  try {
    const workflows = await prisma.workflow.findMany({
      where: { serverId: req.membership!.serverId },
      orderBy: { updatedAt: 'desc' },
    });
    return res.json({ workflows });
  } catch (err) {
    next(err);
  }
});

// GET /servers/:serverId/workflows/:id  (with recent runs)
workflowsRouter.get('/:id', async (req, res, next) => {
  try {
    const workflow = await prisma.workflow.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!workflow) return res.status(404).json({ error: 'not found' });
    const runs = await prisma.workflowRun.findMany({
      where: { workflowId: workflow.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    return res.json({ workflow, runs });
  } catch (err) {
    next(err);
  }
});

const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })).default([]),
  edges: z.array(z.object({
    id: z.string().optional(),
    source: z.string(),
    target: z.string(),
    sourceHandle: z.string().nullable().optional(),
  })).default([]),
});

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  graph: graphSchema.optional(),
  enabled: z.boolean().optional(),
});

// POST /servers/:serverId/workflows
workflowsRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });
    const workflow = await prisma.workflow.create({
      data: {
        serverId: req.membership!.serverId,
        name: body.data.name,
        description: body.data.description ?? '',
        enabled: body.data.enabled ?? true,
        graph: (body.data.graph ?? { nodes: [], edges: [] }) as unknown as Prisma.InputJsonValue,
        createdBy: req.user!.id,
      },
    });
    bus.emit('workflow.updated', { serverId: workflow.serverId, workflow });
    return res.status(201).json({ workflow });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  graph: graphSchema.optional(),
});

// PATCH /servers/:serverId/workflows/:id
workflowsRouter.patch('/:id', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });
    const existing = await prisma.workflow.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!existing) return res.status(404).json({ error: 'not found' });
    const workflow = await prisma.workflow.update({
      where: { id: existing.id },
      data: {
        ...(body.data.name !== undefined && { name: body.data.name }),
        ...(body.data.description !== undefined && { description: body.data.description }),
        ...(body.data.enabled !== undefined && { enabled: body.data.enabled }),
        ...(body.data.graph !== undefined && { graph: body.data.graph as unknown as Prisma.InputJsonValue }),
      },
    });
    bus.emit('workflow.updated', { serverId: workflow.serverId, workflow });
    return res.json({ workflow });
  } catch (err) {
    next(err);
  }
});

// DELETE /servers/:serverId/workflows/:id
workflowsRouter.delete('/:id', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const existing = await prisma.workflow.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!existing) return res.status(404).json({ error: 'not found' });
    await prisma.workflow.delete({ where: { id: existing.id } });
    bus.emit('workflow.updated', { serverId: existing.serverId, workflow: { ...existing, deleted: true } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /servers/:serverId/workflows/:id/run  — manual trigger
workflowsRouter.post('/:id/run', async (req, res, next) => {
  try {
    const workflow = await prisma.workflow.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!workflow) return res.status(404).json({ error: 'not found' });
    const run = await runWorkflow(workflow.id, { trigger: 'manual' });
    return res.status(202).json({ run });
  } catch (err) {
    const msg = (err as Error).message;
    if (/disabled|no trigger|not found|cycle/i.test(msg)) return res.status(400).json({ error: msg });
    next(err);
  }
});
