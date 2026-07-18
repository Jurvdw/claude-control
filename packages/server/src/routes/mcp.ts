import { Router } from 'express';
import { z } from 'zod';
import { MemberRole, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { encrypt } from '../lib/crypto.js';
import { testMcpServer } from '../lib/mcpClient.js';
import { checkMcpPaths } from '../lib/mcpFence.js';

export const mcpRouter = Router({ mergeParams: true });

mcpRouter.use(requireAuth);
mcpRouter.use(requireServerMember());

// Public shape — never leak the encrypted secrets blob.
function view(m: { id: string; name: string; transport: string; command: string | null; args: Prisma.JsonValue; url: string | null; enabled: boolean }) {
  return { id: m.id, name: m.name, transport: m.transport, command: m.command, args: m.args, url: m.url, enabled: m.enabled };
}

mcpRouter.get('/', async (req, res, next) => {
  try {
    const servers = await prisma.mcpServer.findMany({ where: { serverId: req.membership!.serverId }, orderBy: { createdAt: 'asc' } });
    return res.json({ servers: servers.map(view) });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'letters, digits, - and _ only'),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

mcpRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body' });
    const d = body.data;
    if (d.transport === 'stdio' && !d.command) return res.status(400).json({ error: 'stdio needs a command' });
    if (d.transport !== 'stdio' && !d.url) return res.status(400).json({ error: 'sse/http needs a url' });
    // Safety fence: no MCP server may be pointed at the app's own files.
    const fenced = checkMcpPaths({ command: d.command, args: d.args, env: d.env });
    if (fenced) return res.status(400).json({ error: fenced });
    const secrets = (d.env || d.headers) ? encrypt(JSON.stringify({ env: d.env, headers: d.headers })) : null;
    const server = await prisma.mcpServer.create({
      data: {
        serverId: req.membership!.serverId,
        name: d.name,
        transport: d.transport,
        command: d.command,
        args: (d.args ?? []) as Prisma.InputJsonValue,
        url: d.url,
        secretsEnc: secrets,
        enabled: d.enabled ?? true,
      },
    });
    return res.status(201).json({ server: view(server) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'a server with that name already exists' });
    next(err);
  }
});

// POST /:id/test — actually connect and list the server's tools (the guided
// "test it" button). Returns tool names so a non-technical user gets a clear
// "✓ connected, N tools" or an actionable error.
mcpRouter.post('/:id/test', async (req, res, next) => {
  try {
    const row = await prisma.mcpServer.findFirst({ where: { id: req.params.id, serverId: req.membership!.serverId } });
    if (!row) return res.status(404).json({ error: 'not found' });
    const result = await testMcpServer(row);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({ enabled: z.boolean().optional() });

mcpRouter.patch('/:id', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });
    const existing = await prisma.mcpServer.findFirst({ where: { id: req.params.id, serverId: req.membership!.serverId } });
    if (!existing) return res.status(404).json({ error: 'not found' });
    const server = await prisma.mcpServer.update({ where: { id: existing.id }, data: { ...(body.data.enabled !== undefined && { enabled: body.data.enabled }) } });
    return res.json({ server: view(server) });
  } catch (err) {
    next(err);
  }
});

mcpRouter.delete('/:id', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const existing = await prisma.mcpServer.findFirst({ where: { id: req.params.id, serverId: req.membership!.serverId } });
    if (!existing) return res.status(404).json({ error: 'not found' });
    await prisma.mcpServer.delete({ where: { id: existing.id } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
