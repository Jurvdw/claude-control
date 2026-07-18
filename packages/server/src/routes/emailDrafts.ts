import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { bus } from '../realtime/bus.js';
import { enqueueAgentRun } from '../agents/dispatch.js';
import { sendEmail } from '../lib/email.js';

export const emailDraftsRouter = Router({ mergeParams: true });

emailDraftsRouter.use(requireAuth);
emailDraftsRouter.use(requireServerMember());

async function find(req: { params: { id: string }; membership?: { serverId: string } }) {
  return prisma.emailDraft.findFirst({ where: { id: req.params.id, serverId: req.membership!.serverId } });
}

function emit(draft: { serverId: string }) {
  bus.emit('emailDraft.updated', { serverId: draft.serverId, draft });
}

// GET /servers/:serverId/email-drafts/:id — current state of a draft card.
emailDraftsRouter.get('/:id', async (req, res, next) => {
  try {
    const draft = await find(req);
    if (!draft) return res.status(404).json({ error: 'not found' });
    return res.json({ draft });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  to: z.string().min(1).max(500).optional(),
  cc: z.string().max(500).nullable().optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(100_000).optional(),
});

// PATCH — the Commander edited the draft inline. Only pending drafts are editable.
emailDraftsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });
    const draft = await find(req);
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (draft.status !== 'pending') return res.status(409).json({ error: `draft already ${draft.status}` });
    const updated = await prisma.emailDraft.update({ where: { id: draft.id }, data: body.data });
    emit(updated);
    return res.json({ draft: updated });
  } catch (err) {
    next(err);
  }
});

// POST /:id/send — the only path from a draft to SMTP. Sends whatever text is
// currently stored, so inline edits are what actually goes out.
emailDraftsRouter.post('/:id/send', async (req, res, next) => {
  try {
    const draft = await find(req);
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (draft.status !== 'pending') return res.status(409).json({ error: `draft already ${draft.status}` });
    const acc = await prisma.emailAccount.findUnique({ where: { serverId: draft.serverId } });
    if (!acc) return res.status(400).json({ error: 'No mailbox connected. Settings → Email.' });

    let messageId: string;
    try {
      messageId = await sendEmail(acc, { to: draft.to, cc: draft.cc ?? undefined, subject: draft.subject, body: draft.body });
    } catch (e) {
      return res.status(502).json({ error: `Send failed: ${(e as Error).message}` });
    }

    const updated = await prisma.emailDraft.update({
      where: { id: draft.id },
      data: { status: 'sent', sentAt: new Date(), messageId },
    });
    emit(updated);
    return res.json({ draft: updated });
  } catch (err) {
    next(err);
  }
});

emailDraftsRouter.post('/:id/discard', async (req, res, next) => {
  try {
    const draft = await find(req);
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (draft.status === 'sent') return res.status(409).json({ error: 'already sent' });
    const updated = await prisma.emailDraft.update({ where: { id: draft.id }, data: { status: 'discarded' } });
    emit(updated);
    return res.json({ draft: updated });
  } catch (err) {
    next(err);
  }
});

const reviseSchema = z.object({ instruction: z.string().min(1).max(4000) });

// POST /:id/revise — hand the draft back to the agent that wrote it with the
// Commander's change request. The agent re-drafts by calling draft_email again.
emailDraftsRouter.post('/:id/revise', async (req, res, next) => {
  try {
    const body = reviseSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'instruction required' });
    const draft = await find(req);
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (draft.status !== 'pending') return res.status(409).json({ error: `draft already ${draft.status}` });

    // The request goes in the transcript as a Commander message, so the thread
    // reads naturally and the agent sees it in history.
    const msg = await prisma.message.create({
      data: {
        serverId: draft.serverId,
        channelId: draft.channelId ?? undefined,
        dmThreadId: draft.dmThreadId ?? undefined,
        senderType: 'USER',
        userId: req.user!.id,
        content: body.data.instruction,
      },
    });
    bus.emit('message.created', {
      serverId: draft.serverId,
      channelId: draft.channelId ?? null,
      dmThreadId: draft.dmThreadId,
      message: { ...msg, agentName: null, files: [] },
    });

    // Supersede the old card so only one live draft is on screen.
    const updated = await prisma.emailDraft.update({ where: { id: draft.id }, data: { status: 'discarded' } });
    emit(updated);

    await enqueueAgentRun({
      serverId: draft.serverId,
      agentId: draft.agentId,
      trigger: 'manual',
      channelId: draft.channelId,
      dmThreadId: draft.dmThreadId,
      prompt: [
        'The Commander wants changes to the email draft you wrote.',
        `To: ${draft.to}`,
        draft.cc ? `Cc: ${draft.cc}` : '',
        `Subject: ${draft.subject}`,
        '',
        draft.body,
        '',
        `Requested change: ${body.data.instruction}`,
        'Rewrite it and call draft_email again with the full revised email.',
      ]
        .filter(Boolean)
        .join('\n'),
      triggeredByMessageId: msg.id,
    });

    return res.json({ draft: updated });
  } catch (err) {
    next(err);
  }
});
