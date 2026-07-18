import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { bus } from '../realtime/bus.js';
import { enqueueAgentRun } from '../agents/dispatch.js';
import { fireKeywordHooks, fireFileHooks } from '../agents/hooks.js';
import { storage } from '../lib/storage.js';

export const messagesRouter = Router({ mergeParams: true });

messagesRouter.use(requireAuth);
messagesRouter.use(requireServerMember());

const messageSelect = {
  id: true,
  serverId: true,
  channelId: true,
  dmThreadId: true,
  senderType: true,
  userId: true,
  agentId: true,
  agent: { select: { name: true } },
  contentType: true,
  content: true,
  meta: true,
  createdAt: true,
  reactions: { select: { userId: true, kind: true, feedback: true } },
  files: { select: { id: true, name: true, mimeType: true, size: true, storageKey: true } },
};

// GET /servers/:serverId/channels/:channelId/messages
messagesRouter.get('/:channelId/messages', async (req, res, next) => {
  try {
    // Verify channel belongs to this server
    const channel = await prisma.channel.findFirst({
      where: { id: req.params.channelId, serverId: req.membership!.serverId },
    });
    if (!channel) return res.status(404).json({ error: 'channel not found' });

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before as string | undefined;

    const messages = await prisma.message.findMany({
      where: {
        channelId: req.params.channelId,
        serverId: req.membership!.serverId,
        ...(before && { createdAt: { lt: new Date(before) } }),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: messageSelect,
    });

    return res.json({
      messages: messages.map(formatMessage),
    });
  } catch (err) {
    next(err);
  }
});

const createMessageSchema = z.object({
  content: z.string().default(''),
  contentType: z.enum(['TEXT', 'FILE', 'CARD']).default('TEXT'),
  fileIds: z.array(z.string()).optional(),
}).refine((d) => d.content.trim().length > 0 || (d.fileIds && d.fileIds.length > 0), {
  message: 'message must have text or an attachment',
});

// POST /servers/:serverId/channels/:channelId/messages
messagesRouter.post('/:channelId/messages', async (req, res, next) => {
  try {
    const channel = await prisma.channel.findFirst({
      where: { id: req.params.channelId, serverId: req.membership!.serverId },
    });
    if (!channel) return res.status(404).json({ error: 'channel not found' });

    const body = createMessageSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const fileIds = body.data.fileIds ?? [];
    const message = await prisma.message.create({
      data: {
        serverId: req.membership!.serverId,
        channelId: req.params.channelId,
        senderType: 'USER',
        userId: req.user!.id,
        content: body.data.content,
        contentType: fileIds.length && !body.data.content.trim() ? 'FILE' : body.data.contentType,
      },
      select: messageSelect,
    });

    // Link the uploaded attachments to this message (scoped to the server).
    if (fileIds.length) {
      await prisma.fileAsset.updateMany({
        where: { id: { in: fileIds }, serverId: req.membership!.serverId, messageId: null },
        data: { messageId: message.id },
      });
    }
    const full = fileIds.length
      ? await prisma.message.findUnique({ where: { id: message.id }, select: messageSelect })
      : message;

    bus.emit('message.created', {
      serverId: req.membership!.serverId,
      channelId: req.params.channelId,
      message: formatMessage(full ?? message),
    });

    // Parse @mentions and enqueue agent runs
    await triggerMentions(
      body.data.content,
      req.membership!.serverId,
      req.params.channelId,
      message.id,
    );

    // Proactive triggers: keyword hooks + new_file hooks (fire on user messages only).
    await fireKeywordHooks(req.membership!.serverId, req.params.channelId, body.data.content, message.id).catch(() => {});
    if (fileIds.length) {
      const names = (full && 'files' in full ? (full as { files?: { name: string }[] }).files ?? [] : []).map((f) => f.name);
      await fireFileHooks(req.membership!.serverId, req.params.channelId, names, message.id).catch(() => {});
    }

    return res.status(201).json({ message: formatMessage(full ?? message) });
  } catch (err) {
    next(err);
  }
});

// ── DM routes ────────────────────────────────────────────────────────────────

// GET /servers/:serverId/dms/:agentId/messages
messagesRouter.get('/dms/:agentId/messages', async (req, res, next) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, serverId: req.membership!.serverId },
    });
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    const thread = await prisma.dmThread.findFirst({
      where: { serverId: req.membership!.serverId, userId: req.user!.id, agentId: req.params.agentId },
    });

    if (!thread) return res.json({ messages: [] });

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before as string | undefined;

    const messages = await prisma.message.findMany({
      where: {
        dmThreadId: thread.id,
        serverId: req.membership!.serverId,
        ...(before && { createdAt: { lt: new Date(before) } }),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: messageSelect,
    });

    return res.json({ messages: messages.map(formatMessage) });
  } catch (err) {
    next(err);
  }
});

const dmMessageSchema = z.object({
  content: z.string().min(1),
});

// POST /servers/:serverId/dms/:agentId/messages
messagesRouter.post('/dms/:agentId/messages', async (req, res, next) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.agentId, serverId: req.membership!.serverId },
    });
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    const body = dmMessageSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    // Get or create DM thread
    let thread = await prisma.dmThread.findFirst({
      where: { serverId: req.membership!.serverId, userId: req.user!.id, agentId: req.params.agentId },
    });
    if (!thread) {
      thread = await prisma.dmThread.create({
        data: { serverId: req.membership!.serverId, userId: req.user!.id, agentId: req.params.agentId },
      });
    }

    const message = await prisma.message.create({
      data: {
        serverId: req.membership!.serverId,
        dmThreadId: thread.id,
        senderType: 'USER',
        userId: req.user!.id,
        content: body.data.content,
      },
      select: messageSelect,
    });

    bus.emit('message.created', {
      serverId: req.membership!.serverId,
      dmThreadId: thread.id,
      message: formatMessage(message),
    });

    await enqueueAgentRun({
      serverId: req.membership!.serverId,
      agentId: req.params.agentId,
      trigger: 'dm',
      dmThreadId: thread.id,
      hops: 0,
      triggeredByMessageId: message.id,
    });

    return res.status(201).json({ message: formatMessage(message) });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FileRow { id: string; name: string; mimeType: string; size: number; storageKey: string }
function formatMessage(m: Record<string, unknown> & { agent?: { name: string } | null; files?: FileRow[] }) {
  const { agent, files, ...rest } = m;
  return {
    ...rest,
    agentName: agent?.name ?? null,
    files: (files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, url: storage.url(f.storageKey) })),
  };
}

async function triggerMentions(
  content: string,
  serverId: string,
  channelId: string,
  messageId: string,
) {
  const everyone = /@everyone\b/i.test(content);
  const names = [...content.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase());

  const agents = await prisma.agent.findMany({
    where: { serverId, enabled: true },
  });

  const triggered = new Set<string>();

  for (const agent of agents) {
    const handle = agent.name.replace(/\s+/g, '').toLowerCase();
    if (everyone || names.includes(handle)) {
      triggered.add(agent.id);
    }
  }

  for (const agentId of triggered) {
    await enqueueAgentRun({
      serverId,
      agentId,
      trigger: 'mention',
      channelId,
      hops: 0,
      triggeredByMessageId: messageId,
    });
  }
}
