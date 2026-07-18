import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { storage } from '../lib/storage.js';
import { registerTool, type ToolContext } from './registry.js';
import { generateDocument, patchXlsx, type DocFormat, type Slide } from '../lib/documents.js';

const FORMATS: DocFormat[] = ['docx', 'pptx', 'xlsx', 'pdf'];

// Store a generated buffer as a file and post it to the channel as an agent
// message (rendered as a download card). Shared by create + edit.
async function storeAndPost(
  ctx: ToolContext,
  file: { buffer: Buffer; mimeType: string; ext: string; text: string },
  title: string,
  caption?: string,
): Promise<string> {
  const storageKey = await storage.put(file.buffer, { ext: file.ext, contentType: file.mimeType });
  const fileName = `${title.replace(/[^\w.\- ]+/g, '').trim() || 'document'}.${file.ext}`;
  const channelId = ctx.channelId ?? null;

  const message = await prisma.message.create({
    data: {
      serverId: ctx.serverId,
      channelId: channelId ?? undefined,
      dmThreadId: ctx.dmThreadId ?? undefined,
      senderType: 'AGENT',
      agentId: ctx.agent.id,
      contentType: 'FILE',
      content: caption || `📎 ${fileName}`,
      runId: ctx.runId ?? undefined,
    },
  });
  const asset = await prisma.fileAsset.create({
    data: {
      serverId: ctx.serverId,
      messageId: message.id,
      name: fileName,
      mimeType: file.mimeType,
      size: file.buffer.length,
      storageKey,
      extractedText: file.text.slice(0, 20000),
      uploadedBy: ctx.agent.id,
    },
  });
  bus.emit('message.created', {
    serverId: ctx.serverId,
    channelId,
    dmThreadId: ctx.dmThreadId,
    message: {
      ...message,
      agentName: ctx.agent.name,
      files: [{ id: asset.id, name: asset.name, mimeType: asset.mimeType, size: asset.size, url: storage.url(asset.storageKey) }],
    },
  });
  return `${file.ext.toUpperCase()} "${fileName}" (${(file.buffer.length / 1024).toFixed(0)} KB) posted to the channel.`;
}

registerTool({
  name: 'create_document',
  description:
    'Create a downloadable docx/pptx/xlsx/pdf and post it to the channel — use for reports, decks, spreadsheets, handouts. ' +
    'docx/pdf: "content" (markdown). pptx: "slides":[{title,bullets}]. xlsx: "rows":[[header…],[cells…]].',
  input_schema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['docx', 'pptx', 'xlsx', 'pdf'] },
      title: { type: 'string' },
      content: { type: 'string', description: 'Markdown body for docx/pdf' },
      slides: { type: 'array', description: 'Slides for pptx', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } } } },
      rows: { type: 'array', description: 'Rows for xlsx', items: { type: 'array', items: { type: 'string' } } },
      message: { type: 'string', description: 'Optional caption posted with the file' },
    },
    required: ['format', 'title'],
  },
  summarize: (input) => `Create ${String(input.format).toUpperCase()} "${input.title}"`,
  async execute(input, ctx) {
    const format = String(input.format) as DocFormat;
    const title = String(input.title || 'Untitled');
    if (!FORMATS.includes(format)) return `Unsupported format "${format}".`;
    try {
      const gen = await generateDocument({
        format, title,
        content: input.content ? String(input.content) : undefined,
        slides: input.slides as Slide[] | undefined,
        rows: input.rows as string[][] | undefined,
      });
      return 'Created ' + (await storeAndPost(ctx, gen, title, input.message ? String(input.message) : undefined));
    } catch (err) {
      return `Failed to generate ${format}: ${(err as Error).message}`;
    }
  },
});

registerTool({
  name: 'edit_document',
  description:
    'Edit a document already shared here (reference it by name or id; read it first). ' +
    'xlsx: "cellUpdates":[{cell:"B2",value:"…"}] or "appendRows" — keeps formatting. docx/pptx/pdf: pass revised full "content"/"slides" to regenerate.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File name or id to edit' },
      cellUpdates: { type: 'array', description: 'xlsx: cell patches', items: { type: 'object', properties: { cell: { type: 'string' }, value: { type: 'string' } } } },
      appendRows: { type: 'array', description: 'xlsx: rows to append', items: { type: 'array', items: { type: 'string' } } },
      content: { type: 'string', description: 'docx/pdf: revised markdown body' },
      slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } } } },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      message: { type: 'string' },
    },
    required: ['file'],
  },
  summarize: (input) => `Edit document "${input.file}"`,
  async execute(input, ctx) {
    const q = String(input.file);
    const asset = await prisma.fileAsset.findFirst({
      where: { serverId: ctx.serverId, OR: [{ id: q }, { name: { equals: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] },
      orderBy: { createdAt: 'desc' },
    });
    if (!asset) return `No file named "${q}" found.`;
    const ext = (asset.name.split('.').pop() ?? '').toLowerCase() as DocFormat;
    const title = asset.name.replace(/\.[^.]+$/, '');

    try {
      // Excel: true in-place patch preserving formatting.
      if (ext === 'xlsx' && (input.cellUpdates || input.appendRows)) {
        const buf = await storage.get(asset.storageKey);
        const patched = await patchXlsx(buf, {
          cellUpdates: input.cellUpdates as { cell: string; value: string }[] | undefined,
          appendRows: input.appendRows as string[][] | undefined,
        });
        return 'Updated ' + (await storeAndPost(ctx, { ...patched, ext: 'xlsx', mimeType: asset.mimeType }, title, input.message ? String(input.message) : `Updated ${asset.name}`));
      }
      // Everything else: regenerate in the same format from the revised content.
      if (!FORMATS.includes(ext)) return `Can't edit "${asset.name}" — unsupported format.`;
      const gen = await generateDocument({
        format: ext, title,
        content: input.content ? String(input.content) : undefined,
        slides: input.slides as Slide[] | undefined,
        rows: input.rows as string[][] | undefined,
      });
      return 'Updated ' + (await storeAndPost(ctx, gen, title, input.message ? String(input.message) : `Updated ${asset.name}`));
    } catch (err) {
      return `Failed to edit ${asset.name}: ${(err as Error).message}`;
    }
  },
});
