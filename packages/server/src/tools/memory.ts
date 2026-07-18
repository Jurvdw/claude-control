import { prisma } from '../lib/prisma.js';
import { registerTool } from './registry.js';

// Per-agent private memory (domain specifics that would pollute the shared Brain).

registerTool({
  name: 'save_memory',
  description: 'Save a private note to your own memory under a key. Overwrites an existing key.',
  input_schema: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['key', 'content'],
  },
  async execute(input, ctx) {
    const key = String(input.key);
    const content = String(input.content);
    const existing = await prisma.memory.findFirst({
      where: { agentId: ctx.agent.id, key },
    });
    if (existing) {
      await prisma.memory.update({ where: { id: existing.id }, data: { content } });
    } else {
      await prisma.memory.create({
        data: { agentId: ctx.agent.id, serverId: ctx.serverId, key, content },
      });
    }
    return `Saved memory "${key}".`;
  },
});

registerTool({
  name: 'recall_memory',
  description: 'Recall one of your private memories by key.',
  input_schema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
  },
  async execute(input, ctx) {
    const m = await prisma.memory.findFirst({
      where: { agentId: ctx.agent.id, key: String(input.key) },
    });
    return m ? m.content : `No memory found for key "${input.key}".`;
  },
});

registerTool({
  name: 'search_memory',
  description: 'Search your private memories by keyword.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  async execute(input, ctx) {
    const q = String(input.query);
    const rows = await prisma.memory.findMany({
      where: {
        agentId: ctx.agent.id,
        OR: [
          { key: { contains: q, mode: 'insensitive' } },
          { content: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
    });
    if (rows.length === 0) return `No memories match "${q}".`;
    return rows.map((r) => `- ${r.key}: ${r.content.slice(0, 120)}`).join('\n');
  },
});
