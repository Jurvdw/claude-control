import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool } from './registry.js';
import { enqueueAgentRun } from '../agents/dispatch.js';

registerTool({
  name: 'create_task',
  description:
    'Create a task. Optionally assign it to a specific agent by id; otherwise the Manager will assign it.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      assignedAgentId: { type: 'string' },
    },
    required: ['title'],
  },
  async execute(input, ctx) {
    const task = await prisma.task.create({
      data: {
        serverId: ctx.serverId,
        title: String(input.title),
        description: String(input.description ?? ''),
        assignedAgentId: input.assignedAgentId ? String(input.assignedAgentId) : undefined,
        channelId: ctx.channelId ?? undefined,
        mode: input.assignedAgentId ? 'manual' : 'managed',
        createdBy: ctx.agent.id,
      },
    });
    bus.emit('task.updated', { serverId: ctx.serverId, task });
    if (task.assignedAgentId) {
      await enqueueAgentRun({
        serverId: ctx.serverId,
        agentId: task.assignedAgentId,
        trigger: 'task',
        taskId: task.id,
        channelId: task.channelId,
      });
    }
    return `Created task "${task.title}" (${task.id}).`;
  },
});

registerTool({
  name: 'update_task',
  description: 'Update a task status (queued|in_progress|review|done|failed) and/or record its result.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'in_progress', 'review', 'done', 'failed'] },
      result: { type: 'string' },
    },
    required: ['taskId'],
  },
  async execute(input, ctx) {
    const task = await prisma.task.findFirst({
      where: { id: String(input.taskId), serverId: ctx.serverId },
    });
    if (!task) return 'Task not found in this server.';
    const statusMap: Record<string, string> = {
      queued: 'QUEUED',
      in_progress: 'IN_PROGRESS',
      review: 'REVIEW',
      done: 'DONE',
      failed: 'FAILED',
    };
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: input.status ? (statusMap[String(input.status)] as never) : undefined,
        result: input.result ? String(input.result) : undefined,
      },
    });
    bus.emit('task.updated', { serverId: ctx.serverId, task: updated });
    return `Updated task ${task.id}.`;
  },
});
