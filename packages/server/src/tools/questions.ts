import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool, type ToolContext } from './registry.js';

registerTool({
  name: 'ask_question',
  description:
    'Ask the Commander when you genuinely need input to proceed, instead of guessing. ' +
    'Pass "question" plus optional "options" (2–6 short choices) for multiple choice; omit for free text. ' +
    'Then END your turn — the answer arrives as a new message that resumes you.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'What you need to know' },
      options: {
        type: 'array',
        description: 'Optional multiple-choice answers (omit for free text)',
        items: { type: 'string' },
      },
    },
    required: ['question'],
  },
  summarize: (input) => `Ask: ${input.question}`,
  async execute(input, ctx: ToolContext) {
    const prompt = String(input.question ?? '').trim();
    if (!prompt) return 'A question needs text.';
    const options = Array.isArray(input.options)
      ? input.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6)
      : [];
    const kind = options.length >= 2 ? 'choice' : 'open';

    const question = await prisma.agentQuestion.create({
      data: {
        serverId: ctx.serverId,
        agentId: ctx.agent.id,
        channelId: ctx.channelId ?? undefined,
        dmThreadId: ctx.dmThreadId ?? undefined,
        runId: ctx.runId ?? undefined,
        prompt,
        kind,
        options: options as Prisma.InputJsonValue,
      },
    });

    // Post the question as an inline card in the conversation.
    const message = await prisma.message.create({
      data: {
        serverId: ctx.serverId,
        channelId: ctx.channelId ?? undefined,
        dmThreadId: ctx.dmThreadId ?? undefined,
        senderType: 'AGENT',
        agentId: ctx.agent.id,
        contentType: 'CARD',
        content: `❓ ${prompt}`,
        meta: { questionId: question.id } as Prisma.InputJsonValue,
        runId: ctx.runId ?? undefined,
      },
    });
    bus.emit('message.created', {
      serverId: ctx.serverId,
      channelId: ctx.channelId ?? null,
      dmThreadId: ctx.dmThreadId,
      message: { ...message, agentName: ctx.agent.name, files: [] },
    });

    return kind === 'choice'
      ? `Asked the Commander: "${prompt}" (choices: ${options.join(', ')}). End your turn now — their answer will arrive as a new message.`
      : `Asked the Commander: "${prompt}". End your turn now — their answer will arrive as a new message.`;
  },
});
