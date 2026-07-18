import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool, type ToolContext } from './registry.js';

// Emit both the plan update (for live plan cards) and, on creation, a chat
// message card so the plan appears inline where the request was made.
async function emitPlan(planId: string, serverId: string): Promise<void> {
  const plan = await prisma.plan.findUnique({
    where: { id: planId },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
  if (plan) bus.emit('plan.updated', { serverId, plan });
}

registerTool({
  name: 'create_plan',
  description:
    'Break a complex request into a visible plan. Call FIRST for any genuinely multi-step task (not one-shot replies), before doing the work. ' +
    'Pass "goal" and ordered "steps" (each a short "title", optionally the "agent"), then execute them, calling update_plan_step running → done.',
  input_schema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'One-line description of the overall objective' },
      steps: {
        type: 'array',
        description: 'Ordered list of step descriptions (short strings)',
        items: { type: 'string' },
      },
    },
    required: ['goal', 'steps'],
  },
  summarize: (input) => `Plan: ${input.goal}`,
  async execute(input, ctx: ToolContext) {
    const goal = String(input.goal ?? '').trim();
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    // Accept plain strings (what models produce) or {title, agent} objects.
    const steps = rawSteps
      .map((s) => {
        if (typeof s === 'string') return { title: s.trim(), agent: '' };
        const o = (s ?? {}) as { title?: unknown; agent?: unknown };
        return { title: String(o.title ?? '').trim(), agent: o.agent ? String(o.agent).trim() : '' };
      })
      .filter((s) => s.title)
      .slice(0, 25);
    if (!goal || steps.length === 0) return 'A plan needs a goal and at least one step (steps is a list of short strings).';

    const plan = await prisma.plan.create({
      data: {
        serverId: ctx.serverId,
        agentId: ctx.agent.id,
        channelId: ctx.channelId ?? undefined,
        dmThreadId: ctx.dmThreadId ?? undefined,
        runId: ctx.runId ?? undefined,
        goal,
        steps: {
          create: steps.map((s, i) => ({
            order: i + 1,
            title: s.title,
            agentName: s.agent || null,
          })),
        },
      },
      include: { steps: { orderBy: { order: 'asc' } } },
    });

    // Post an inline card into the conversation so the plan is watchable in chat.
    const message = await prisma.message.create({
      data: {
        serverId: ctx.serverId,
        channelId: ctx.channelId ?? undefined,
        dmThreadId: ctx.dmThreadId ?? undefined,
        senderType: 'AGENT',
        agentId: ctx.agent.id,
        contentType: 'CARD',
        content: `📋 Plan: ${goal}`,
        meta: { planId: plan.id } as Prisma.InputJsonValue,
        runId: ctx.runId ?? undefined,
      },
    });
    bus.emit('message.created', {
      serverId: ctx.serverId,
      channelId: ctx.channelId ?? null,
      dmThreadId: ctx.dmThreadId,
      message: { ...message, agentName: ctx.agent.name, files: [] },
    });
    bus.emit('plan.updated', { serverId: ctx.serverId, plan });

    const list = plan.steps.map((s) => `${s.order}. ${s.title}`).join('\n');
    return `Created plan "${goal}" (planId ${plan.id}) with ${plan.steps.length} steps:\n${list}\n\nNow carry them out, calling update_plan_step with { planId, step: <number>, status: "running"|"done"|"failed", result? } as you progress.`;
  },
});

registerTool({
  name: 'update_plan_step',
  description:
    'Update a step of a plan you created so the Commander sees live progress. Pass the "planId", the "step" (its number), ' +
    'a "status" (running | done | failed | skipped), and optionally a short "result". When every step is done the plan completes automatically.',
  input_schema: {
    type: 'object',
    properties: {
      planId: { type: 'string' },
      step: { type: 'number', description: 'The step number (order) to update' },
      status: { type: 'string', enum: ['running', 'done', 'failed', 'skipped'] },
      result: { type: 'string', description: 'Optional short note on the outcome' },
    },
    required: ['planId', 'step', 'status'],
  },
  summarize: (input) => `Plan step ${input.step} → ${input.status}`,
  async execute(input, ctx: ToolContext) {
    const planId = String(input.planId ?? '');
    const order = Number(input.step);
    const status = String(input.status ?? '');
    if (!['running', 'done', 'failed', 'skipped'].includes(status)) return `Invalid status "${status}".`;

    const plan = await prisma.plan.findFirst({ where: { id: planId, serverId: ctx.serverId }, include: { steps: true } });
    if (!plan) return `No plan ${planId} found.`;
    // Match by step number, or fall back to matching the step title.
    const stepRow = plan.steps.find((s) => s.order === order)
      ?? plan.steps.find((s) => s.title.toLowerCase() === String(input.step).trim().toLowerCase());
    if (!stepRow) return `Plan ${planId} has no step ${input.step}. Steps are numbered 1–${plan.steps.length}.`;

    await prisma.planStep.update({
      where: { id: stepRow.id },
      data: { status, result: input.result != null ? String(input.result).slice(0, 2000) : undefined },
    });

    // Roll the plan status up: done when all steps resolved (done/skipped),
    // failed if any step failed.
    const steps = await prisma.planStep.findMany({ where: { planId } });
    const anyFailed = steps.some((s) => s.status === 'failed');
    const allResolved = steps.every((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed');
    const planStatus = anyFailed && allResolved ? 'failed' : allResolved ? 'done' : 'active';
    if (planStatus !== plan.status) {
      await prisma.plan.update({ where: { id: planId }, data: { status: planStatus } });
    }

    await emitPlan(planId, ctx.serverId);
    return `Step ${order} of "${plan.goal}" → ${status}.` + (planStatus !== 'active' ? ` Plan is now ${planStatus}.` : '');
  },
});
