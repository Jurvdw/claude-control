import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MemberRole, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { randomToken } from '../lib/crypto.js';
import { enqueueAgentRun } from '../agents/dispatch.js';
import { runWorkflow } from '../workflows/engine.js';
import { startTunnel, stopTunnel, tunnelStatus } from '../lib/tunnel.js';
import { env } from '../config/env.js';

export const hooksRouter = Router({ mergeParams: true });

hooksRouter.use(requireAuth);
hooksRouter.use(requireServerMember());

hooksRouter.get('/', async (req, res, next) => {
  try {
    const hooks = await prisma.hook.findMany({
      where: { serverId: req.membership!.serverId },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ hooks });
  } catch (err) {
    next(err);
  }
});

const hookSchema = z.object({
  name: z.string().min(1),
  trigger: z.enum(['new_file', 'keyword', 'webhook']),
  config: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().min(1),
  channelId: z.string().optional(),
  promptTemplate: z.string().min(1),
  enabled: z.boolean().optional(),
});

hooksRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = hookSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const hook = await prisma.hook.create({
      data: {
        serverId: req.membership!.serverId,
        name: body.data.name,
        trigger: body.data.trigger,
        config: (body.data.config ?? {}) as Prisma.InputJsonValue,
        agentId: body.data.agentId,
        channelId: body.data.channelId,
        promptTemplate: body.data.promptTemplate,
        enabled: body.data.enabled ?? true,
      },
    });
    return res.status(201).json({ hook });
  } catch (err) {
    next(err);
  }
});

const patchHookSchema = hookSchema.partial();

// GET /servers/:serverId/webhook — get (or create) the inbound webhook URL
hooksRouter.get('/webhook', async (req, res, next) => {
  try {
    let webhook = await prisma.serverWebhook.findFirst({
      where: { serverId: req.membership!.serverId },
    });
    if (!webhook) {
      webhook = await prisma.serverWebhook.create({
        data: { serverId: req.membership!.serverId, secret: randomToken(24) },
      });
    }
    const url = `${env.API_URL}/webhooks/${webhook.secret}`;
    // `secret` doubles as the HMAC signing key when signatures are required.
    return res.json({ url, secret: webhook.secret, requireSignature: webhook.requireSignature });
  } catch (err) {
    next(err);
  }
});

// PATCH /servers/:serverId/webhook — toggle signature requirement or rotate the secret
hooksRouter.patch('/webhook', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = z.object({ requireSignature: z.boolean().optional(), rotate: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });
    let webhook = await prisma.serverWebhook.findFirst({ where: { serverId: req.membership!.serverId } });
    if (!webhook) {
      webhook = await prisma.serverWebhook.create({ data: { serverId: req.membership!.serverId, secret: randomToken(24) } });
    }
    webhook = await prisma.serverWebhook.update({
      where: { id: webhook.id },
      data: {
        ...(body.data.requireSignature !== undefined && { requireSignature: body.data.requireSignature }),
        ...(body.data.rotate && { secret: randomToken(24) }),
      },
    });
    const url = `${env.API_URL}/webhooks/${webhook.secret}`;
    return res.json({ url, secret: webhook.secret, requireSignature: webhook.requireSignature });
  } catch (err) {
    next(err);
  }
});

// ── Public tunnel (localtunnel) ──────────────────────────────────────────────
// GET /servers/:serverId/hooks/tunnel · POST .../tunnel/start · POST .../tunnel/stop
hooksRouter.get('/tunnel', async (_req, res) => res.json(tunnelStatus()));

hooksRouter.post('/tunnel/start', requireServerMember(MemberRole.ADMIN), async (_req, res) => {
  try {
    const r = await startTunnel();
    return res.json({ ...tunnelStatus(), url: r.url });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

hooksRouter.post('/tunnel/stop', requireServerMember(MemberRole.ADMIN), async (_req, res) => {
  stopTunnel();
  return res.json(tunnelStatus());
});

// Parameterized hook routes come last so literal paths (/webhook, /tunnel) win.
hooksRouter.patch('/:hookId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = patchHookSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const h = await prisma.hook.findFirst({
      where: { id: req.params.hookId, serverId: req.membership!.serverId },
    });
    if (!h) return res.status(404).json({ error: 'not found' });

    const hook = await prisma.hook.update({
      where: { id: h.id },
      data: body.data as unknown as Prisma.HookUncheckedUpdateInput,
    });
    return res.json({ hook });
  } catch (err) {
    next(err);
  }
});

hooksRouter.delete('/:hookId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const h = await prisma.hook.findFirst({
      where: { id: req.params.hookId, serverId: req.membership!.serverId },
    });
    if (!h) return res.status(404).json({ error: 'not found' });

    await prisma.hook.delete({ where: { id: h.id } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Public webhook receiver ───────────────────────────────────────────────────
// POST /webhooks/:secret            — fire all webhook hooks/workflows (catch-all)
// POST /webhooks/:secret/:event     — only those tagged with the same event
// The request body is passed to matching workflows as their entry input.
export const webhookReceiverRouter = Router();

// A workflow matches when it's enabled, has a trigger.webhook node, and that
// node's `event` is empty (catch-all) or equals the requested event.
function webhookNodeEvent(graph: unknown): { has: boolean; event: string } {
  const nodes = ((graph ?? {}) as { nodes?: { type: string; data?: { event?: string } }[] }).nodes ?? [];
  const node = nodes.find((n) => n.type === 'trigger.webhook');
  return { has: !!node, event: String(node?.data?.event ?? '').trim() };
}

// Constant-time compare of two strings (returns false on any length mismatch).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function receive(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const webhook = await prisma.serverWebhook.findUnique({ where: { secret: req.params.secret } });
    if (!webhook) { res.status(404).json({ error: 'not found' }); return; }

    // Optional HMAC verification. When enabled, the caller must send
    // `X-CC-Signature: sha256=<hex>` over the raw body, keyed by the secret.
    if (webhook.requireSignature) {
      const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
      const expected = 'sha256=' + createHmac('sha256', webhook.secret).update(raw).digest('hex');
      const provided = String(req.header('x-cc-signature') ?? '');
      if (!safeEqual(provided, expected)) {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
    }

    // Event can come from the path (/webhooks/:secret/:event), ?event=, or body.event.
    const event = String(
      (req.params as { event?: string }).event ??
      (req.query as { event?: string }).event ??
      ((req.body as { event?: string } | undefined)?.event) ??
      '',
    ).trim();

    // Serialize the payload once as the workflow entry input.
    const body = req.body;
    const input = typeof body === 'string' ? body : JSON.stringify(body ?? {});

    // Fire all webhook-type hooks for this server (event-agnostic).
    const hooks = await prisma.hook.findMany({
      where: { serverId: webhook.serverId, trigger: 'webhook', enabled: true },
    });
    for (const hook of hooks) {
      await enqueueAgentRun({
        serverId: webhook.serverId,
        agentId: hook.agentId,
        trigger: 'hook',
        channelId: hook.channelId,
        prompt: `${hook.promptTemplate}\n\nWebhook payload:\n${input}`,
        hops: 0,
      });
    }

    // Fire matching webhook-triggered workflows.
    const workflows = await prisma.workflow.findMany({
      where: { serverId: webhook.serverId, enabled: true },
    });
    let started = 0;
    for (const wf of workflows) {
      const { has, event: wantEvent } = webhookNodeEvent(wf.graph);
      if (!has) continue;
      if (wantEvent && wantEvent.toLowerCase() !== event.toLowerCase()) continue;
      await runWorkflow(wf.id, { trigger: 'webhook', input, entryType: 'trigger.webhook' }).catch(() => {});
      started++;
    }

    res.json({ ok: true, hooksFired: hooks.length, workflowsStarted: started });
  } catch (err) {
    next(err);
  }
}

webhookReceiverRouter.post('/:secret', receive);
webhookReceiverRouter.post('/:secret/:event', receive);
