import { Router } from 'express';
import { z } from 'zod';
import { MemberRole, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { allTools } from '../tools/index.js';

export const agentsRouter = Router({ mergeParams: true });

agentsRouter.use(requireAuth);

// GET /agent-templates (global, no server scope)
export const agentTemplatesRouter = Router();
agentTemplatesRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const templates = await prisma.agentTemplate.findMany({ orderBy: { name: 'asc' } });
    return res.json({ templates });
  } catch (err) {
    next(err);
  }
});

// GET /tools (global)
export const toolsRouter = Router();
toolsRouter.get('/', requireAuth, async (_req, res) => {
  const tools = allTools().map((t) => ({
    name: t.name,
    description: t.description,
    requiresApproval: t.requiresApproval ?? false,
  }));
  return res.json({ tools });
});

// Agent CRUD under /servers/:serverId/agents
agentsRouter.get('/', requireServerMember(), async (req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { serverId: req.params.serverId },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ agents });
  } catch (err) {
    next(err);
  }
});

const createAgentSchema = z.object({
  name: z.string().min(1),
  avatarUrl: z.string().url().optional(),
  bio: z.string().optional(),
  statusText: z.string().optional(),
  systemPrompt: z.string().min(1),
  modelClass: z.enum(['HAIKU', 'SONNET', 'OPUS']).optional(),
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  personality: z.number().int().min(0).max(100).optional(),
  enabledTools: z.array(z.string()).optional(),
  isManager: z.boolean().optional(),
  roleColor: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  proactivity: z.record(z.string(), z.unknown()).optional(),
});

agentsRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = createAgentSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const agent = await prisma.agent.create({
      data: {
        serverId: req.membership!.serverId,
        name: body.data.name,
        avatarUrl: body.data.avatarUrl ?? '',
        bio: body.data.bio ?? '',
        statusText: body.data.statusText ?? '',
        systemPrompt: body.data.systemPrompt,
        ...(body.data.modelClass && { modelClass: body.data.modelClass }),
        ...(body.data.effort && { effort: body.data.effort }),
        ...(body.data.personality !== undefined && { personality: body.data.personality }),
        ...(body.data.enabledTools && { enabledTools: body.data.enabledTools as Prisma.InputJsonValue }),
        ...(body.data.isManager !== undefined && { isManager: body.data.isManager }),
        ...(body.data.requiresApproval !== undefined && { requiresApproval: body.data.requiresApproval }),
        ...(body.data.proactivity && { proactivity: body.data.proactivity as Prisma.InputJsonValue }),
      },
    });
    return res.status(201).json({ agent });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:agentId', requireServerMember(), async (req, res, next) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, serverId: req.membership!.serverId },
    });
    if (!agent) return res.status(404).json({ error: 'not found' });
    return res.json({ agent });
  } catch (err) {
    next(err);
  }
});

const patchAgentSchema = z.object({
  name: z.string().min(1).optional(),
  avatarUrl: z.string().url().optional(),
  bio: z.string().optional(),
  statusText: z.string().optional(),
  systemPrompt: z.string().min(1).optional(),
  modelClass: z.enum(['HAIKU', 'SONNET', 'OPUS']).optional(),
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  personality: z.number().int().min(0).max(100).optional(),
  enabledTools: z.array(z.string()).optional(),
  isManager: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  proactivity: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(['IDLE', 'THINKING', 'WORKING', 'ERROR', 'PAUSED']).optional(),
});

agentsRouter.patch('/:agentId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = patchAgentSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, serverId: req.membership!.serverId },
    });
    if (!agent) return res.status(404).json({ error: 'not found' });

    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: body.data as unknown as Prisma.AgentUncheckedUpdateInput,
    });
    return res.json({ agent: updated });
  } catch (err) {
    next(err);
  }
});

agentsRouter.delete('/:agentId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, serverId: req.membership!.serverId },
    });
    if (!agent) return res.status(404).json({ error: 'not found' });

    await prisma.agent.delete({ where: { id: agent.id } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:agentId/pause', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, serverId: req.membership!.serverId },
    });
    if (!agent) return res.status(404).json({ error: 'not found' });

    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'PAUSED', enabled: false },
    });
    return res.json({ agent: updated });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:agentId/resume', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, serverId: req.membership!.serverId },
    });
    if (!agent) return res.status(404).json({ error: 'not found' });

    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'IDLE', enabled: true },
    });
    return res.json({ agent: updated });
  } catch (err) {
    next(err);
  }
});
