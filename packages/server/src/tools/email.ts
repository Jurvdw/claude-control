import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool, type ToolContext } from './registry.js';
import * as mail from '../lib/email.js';

const NO_ACCOUNT = 'No mailbox is connected for this workspace. Connect one in Settings → Email (Gmail/Outlook app password).';

async function account(ctx: ToolContext) {
  return prisma.emailAccount.findUnique({ where: { serverId: ctx.serverId } });
}

registerTool({
  name: 'list_emails',
  description: 'List recent emails from a mailbox (default the inbox). Returns uid, sender, subject, date, and unread flag. Use read_email with a uid to open one.',
  input_schema: {
    type: 'object',
    properties: {
      mailbox: { type: 'string', description: 'Mailbox/label to list (default INBOX)' },
      limit: { type: 'number', description: 'How many recent messages (default 20, max 50)' },
    },
  },
  async execute(input, ctx) {
    const acc = await account(ctx);
    if (!acc) return NO_ACCOUNT;
    try {
      const msgs = await mail.listEmails(acc, String(input.mailbox ?? 'INBOX'), Math.min(Number(input.limit) || 20, 50));
      if (msgs.length === 0) return 'No messages found.';
      return msgs.map((m) => `[uid ${m.uid}]${m.unread ? ' •' : ''} ${m.from} — ${m.subject} (${m.date.slice(0, 10)})`).join('\n');
    } catch (e) {
      return `Couldn't list emails: ${(e as Error).message}`;
    }
  },
});

registerTool({
  name: 'search_emails',
  description: 'Search the mailbox by free text, sender, subject, and/or unread only. Returns matching messages (uid, sender, subject, date).',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Words to find in the body' },
      from: { type: 'string', description: 'Sender address/name contains' },
      subject: { type: 'string', description: 'Subject contains' },
      unread: { type: 'boolean', description: 'Only unread messages' },
      mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' },
    },
  },
  async execute(input, ctx) {
    const acc = await account(ctx);
    if (!acc) return NO_ACCOUNT;
    try {
      const msgs = await mail.searchEmails(
        acc,
        { text: input.text ? String(input.text) : undefined, from: input.from ? String(input.from) : undefined, subject: input.subject ? String(input.subject) : undefined, unread: input.unread === true },
        String(input.mailbox ?? 'INBOX'),
      );
      if (msgs.length === 0) return 'No matching emails.';
      return msgs.map((m) => `[uid ${m.uid}]${m.unread ? ' •' : ''} ${m.from} — ${m.subject} (${m.date.slice(0, 10)})`).join('\n');
    } catch (e) {
      return `Search failed: ${(e as Error).message}`;
    }
  },
});

registerTool({
  name: 'read_email',
  description: 'Read the full body of one email by its uid (from list_emails/search_emails).',
  input_schema: {
    type: 'object',
    properties: {
      uid: { type: 'number' },
      mailbox: { type: 'string', description: 'Mailbox the message is in (default INBOX)' },
    },
    required: ['uid'],
  },
  async execute(input, ctx) {
    const acc = await account(ctx);
    if (!acc) return NO_ACCOUNT;
    try {
      const r = await mail.readEmail(acc, Number(input.uid), String(input.mailbox ?? 'INBOX'));
      if (!r) return `No message with uid ${input.uid}.`;
      return `From: ${r.summary.from}\nSubject: ${r.summary.subject}\nDate: ${r.summary.date}\n\n${r.body}`;
    } catch (e) {
      return `Couldn't read email: ${(e as Error).message}`;
    }
  },
});

registerTool({
  name: 'email_folders',
  description: 'List the mailboxes / labels this account can sort emails into.',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    const acc = await account(ctx);
    if (!acc) return NO_ACCOUNT;
    try {
      const folders = await mail.listFolders(acc);
      return folders.length ? folders.join('\n') : 'No folders found.';
    } catch (e) {
      return `Couldn't list folders: ${(e as Error).message}`;
    }
  },
});

registerTool({
  name: 'sort_email',
  description: 'Move/label an email into a mailbox or Gmail label — e.g. filing it under the right folder. Pass the message uid and the destination folder/label (see email_folders). For Gmail this applies the label and removes it from the inbox.',
  input_schema: {
    type: 'object',
    properties: {
      uid: { type: 'number' },
      to_folder: { type: 'string', description: 'Destination mailbox / Gmail label' },
      from_mailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
    },
    required: ['uid', 'to_folder'],
  },
  summarize: (input) => `Sort email ${input.uid} → ${input.to_folder}`,
  async execute(input, ctx) {
    const acc = await account(ctx);
    if (!acc) return NO_ACCOUNT;
    try {
      await mail.sortEmail(acc, Number(input.uid), String(input.to_folder), String(input.from_mailbox ?? 'INBOX'));
      return `Moved email ${input.uid} to "${input.to_folder}".`;
    } catch (e) {
      return `Couldn't sort email: ${(e as Error).message}`;
    }
  },
});

registerTool({
  name: 'draft_email',
  description:
    'Compose an email as an editable draft card the Commander can edit, revise, or send. This is the normal way to send mail — prefer it over send_email.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient address' },
      cc: { type: 'string', description: 'Optional CC address(es), comma-separated' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Full body text, ready to send' },
    },
    required: ['to', 'subject', 'body'],
  },
  summarize: (input) => `Draft email to ${input.to}: "${input.subject}"`,
  async execute(input, ctx) {
    const acc = await account(ctx);
    const draft = await prisma.emailDraft.create({
      data: {
        serverId: ctx.serverId,
        agentId: ctx.agent.id,
        channelId: ctx.channelId ?? undefined,
        dmThreadId: ctx.dmThreadId ?? undefined,
        runId: ctx.runId ?? undefined,
        fromAddr: acc?.email ?? null,
        to: String(input.to),
        cc: input.cc ? String(input.cc) : null,
        subject: String(input.subject),
        body: String(input.body),
      },
    });

    const target = ctx.channelId ? { channelId: ctx.channelId } : ctx.dmThreadId ? { dmThreadId: ctx.dmThreadId } : null;
    if (target) {
      const message = await prisma.message.create({
        data: {
          serverId: ctx.serverId,
          ...target,
          senderType: 'AGENT',
          agentId: ctx.agent.id,
          contentType: 'CARD',
          content: `✉️ Draft: ${draft.subject}`,
          meta: { kind: 'email_draft', draftId: draft.id } as Prisma.InputJsonValue,
          runId: ctx.runId ?? undefined,
        },
      });
      bus.emit('message.created', {
        serverId: ctx.serverId,
        channelId: ctx.channelId ?? null,
        dmThreadId: ctx.dmThreadId,
        message: { ...message, agentName: ctx.agent.name, files: [] },
      });
    }

    return acc
      ? 'Draft posted for the Commander to review. Do not restate it — stop here and wait; you will be re-triggered if they want changes.'
      : `Draft saved, but ${NO_ACCOUNT} It cannot be sent until a mailbox is connected.`;
  },
});

registerTool({
  name: 'send_email',
  description: 'Send an email from the connected mailbox. This actually sends via SMTP, so it goes through approval first.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
  requiresApproval: true,
  summarize: (input) => `Email to ${input.to}: "${input.subject}"`,
  async execute(input, ctx) {
    const acc = await account(ctx);
    if (!acc) return `${NO_ACCOUNT} (draft was: to ${input.to} — "${input.subject}")`;
    try {
      const id = await mail.sendEmail(acc, { to: String(input.to), subject: String(input.subject), body: String(input.body) });
      return `Sent email to ${input.to} ("${input.subject}"). Message-ID ${id}`;
    } catch (e) {
      return `Send failed: ${(e as Error).message}`;
    }
  },
});
