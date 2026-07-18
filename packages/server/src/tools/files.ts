import { prisma } from '../lib/prisma.js';
import { storage } from '../lib/storage.js';
import { bus } from '../realtime/bus.js';
import { registerTool } from './registry.js';

// Create a file (markdown, code, text). Code files post a summary + card in chat;
// documents/deliverables are saved to the server's Outputs area.
registerTool({
  name: 'create_file',
  description:
    'Create a file (markdown, code, text, etc.). Deliverables/documents are saved to Outputs; a link/card is posted in chat.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Filename incl. extension, e.g. report.md' },
      content: { type: 'string' },
      kind: { type: 'string', enum: ['code', 'document'], description: 'Defaults to document' },
    },
    required: ['name', 'content'],
  },
  summarize: (input) => `Create file ${input.name}`,
  async execute(input, ctx) {
    const name = String(input.name);
    const content = String(input.content);
    const kind = String(input.kind ?? 'document');
    const ext = name.includes('.') ? name.split('.').pop()! : 'txt';
    const buffer = Buffer.from(content, 'utf8');
    const key = await storage.put(buffer, { ext });

    const output = await prisma.output.create({
      data: {
        serverId: ctx.serverId,
        taskId: ctx.taskId ?? undefined,
        name,
        mimeType: guessMime(ext),
        size: buffer.byteLength,
        storageKey: key,
        createdByAgentId: ctx.agent.id,
      },
    });

    // Post a file card in the current channel.
    if (ctx.channelId) {
      const message = await prisma.message.create({
        data: {
          serverId: ctx.serverId,
          channelId: ctx.channelId,
          senderType: 'AGENT',
          agentId: ctx.agent.id,
          contentType: 'CARD',
          content: `Created **${name}** (${kind})`,
          meta: { outputId: output.id, name, url: storage.url(key), size: buffer.byteLength },
          runId: ctx.runId ?? undefined,
        },
      });
      bus.emit('message.created', { serverId: ctx.serverId, channelId: ctx.channelId, message });
    }
    return `Created file "${name}" (${buffer.byteLength} bytes) — saved to Outputs.`;
  },
});

// Read a previously uploaded/created file's text (uses server-side extracted text for PDFs/docs).
registerTool({
  name: 'read_file',
  description: 'Read the text content of an uploaded file or output by id or name.',
  input_schema: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      name: { type: 'string' },
    },
  },
  async execute(input, ctx) {
    const where = input.fileId
      ? { id: String(input.fileId), serverId: ctx.serverId }
      : { serverId: ctx.serverId, name: String(input.name ?? '') };
    const file = await prisma.fileAsset.findFirst({ where });
    if (!file) return 'File not found in this server.';
    if (file.extractedText) return file.extractedText;
    try {
      const buf = await storage.get(file.storageKey);
      return buf.toString('utf8').slice(0, 20000);
    } catch {
      return `File "${file.name}" is not readable as text.`;
    }
  },
});

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    js: 'text/javascript',
    ts: 'text/typescript',
    py: 'text/x-python',
    csv: 'text/csv',
    html: 'text/html',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}
