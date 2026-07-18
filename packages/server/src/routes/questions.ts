import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { bus } from '../realtime/bus.js';
import { enqueueAgentRun } from '../agents/dispatch.js';

export const questionsRouter = Router({ mergeParams: true });

questionsRouter.use(requireAuth);
questionsRouter.use(requireServerMember());

// GET /servers/:serverId/questions/:id — current state of a question card.
questionsRouter.get('/:id', async (req, res, next) => {
  try {
    const question = await prisma.agentQuestion.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!question) return res.status(404).json({ error: 'not found' });
    return res.json({ question });
  } catch (err) {
    next(err);
  }
});

const answerSchema = z.object({ answer: z.string().min(1).max(4000) });

// POST /servers/:serverId/questions/:id/answer — record the answer, post it as a
// message, and re-trigger the asking agent so it continues where it left off.
questionsRouter.post('/:id/answer', async (req, res, next) => {
  try {
    const body = answerSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'answer required' });

    const question = await prisma.agentQuestion.findFirst({
      where: { id: req.params.id, serverId: req.membership!.serverId },
    });
    if (!question) return res.status(404).json({ error: 'not found' });
    if (question.status === 'answered') return res.status(409).json({ error: 'already answered' });

    // Validate a choice answer against the allowed options.
    const options = Array.isArray(question.options) ? (question.options as string[]) : [];
    if (question.kind === 'choice' && options.length && !options.includes(body.data.answer)) {
      return res.status(400).json({ error: 'answer must be one of the options' });
    }

    const updated = await prisma.agentQuestion.update({
      where: { id: question.id },
      data: { status: 'answered', answer: body.data.answer },
    });
    bus.emit('question.updated', { serverId: question.serverId, question: updated });

    // Post the answer as a Commander message so it's in the transcript + visible.
    const msg = await prisma.message.create({
      data: {
        serverId: question.serverId,
        channelId: question.channelId ?? undefined,
        dmThreadId: question.dmThreadId ?? undefined,
        senderType: 'USER',
        userId: req.user!.id,
        content: body.data.answer,
      },
    });
    bus.emit('message.created', {
      serverId: question.serverId,
      channelId: question.channelId ?? null,
      dmThreadId: question.dmThreadId,
      message: { ...msg, agentName: null, files: [] },
    });

    // Resume the agent that asked, handing it the answer.
    await enqueueAgentRun({
      serverId: question.serverId,
      agentId: question.agentId,
      trigger: 'manual',
      channelId: question.channelId,
      dmThreadId: question.dmThreadId,
      prompt: `The Commander answered your question "${question.prompt}": ${body.data.answer}\nContinue the task with this answer.`,
      triggeredByMessageId: msg.id,
    });

    return res.json({ question: updated });
  } catch (err) {
    next(err);
  }
});
