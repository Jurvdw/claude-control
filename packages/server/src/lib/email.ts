// IMAP (read / search / sort) + SMTP (send) over an app password. Kept
// dependency-light: connections are opened per operation and closed after, which
// is fine for the app's low-frequency, agent-driven usage.

import { createRequire } from 'node:module';
import type { EmailAccount } from '@prisma/client';
import { decrypt } from './crypto.js';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);
// imapflow / nodemailer are CJS-friendly; load via require to avoid ESM interop noise.
const { ImapFlow } = require('imapflow') as { ImapFlow: new (opts: unknown) => ImapClient };
const nodemailer = require('nodemailer') as {
  createTransport: (opts: unknown) => { sendMail: (m: unknown) => Promise<{ messageId: string }>; verify: () => Promise<true> };
};

interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release: () => void }>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  search(query: Record<string, unknown>, opts?: { uid?: boolean }): Promise<number[]>;
  fetch(range: string | number[], query: Record<string, unknown>, opts?: { uid?: boolean }): AsyncIterable<ImapMessage>;
  fetchOne(seq: string | number, query: Record<string, unknown>, opts?: { uid?: boolean }): Promise<ImapMessage | false>;
  messageMove(range: string | number[], dest: string, opts?: { uid?: boolean }): Promise<unknown>;
  mailboxOpen(path: string): Promise<{ exists: number }>;
}
interface ImapMessage {
  uid: number;
  flags?: Set<string>;
  envelope?: { subject?: string; date?: Date; from?: { name?: string; address?: string }[]; to?: { name?: string; address?: string }[] };
  source?: Buffer;
}

export interface EmailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
}

function imapConfig(acc: EmailAccount) {
  return { host: acc.imapHost, port: acc.imapPort, secure: acc.secure, auth: { user: acc.email, pass: decrypt(acc.passwordEnc) }, logger: false };
}

async function withImap<T>(acc: EmailAccount, mailbox: string, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  const client = new ImapFlow(imapConfig(acc));
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

function addr(m: ImapMessage): string {
  const f = m.envelope?.from?.[0];
  return f ? (f.name ? `${f.name} <${f.address}>` : f.address ?? '') : '';
}
function summarize(m: ImapMessage): EmailSummary {
  return {
    uid: m.uid,
    from: addr(m),
    subject: m.envelope?.subject ?? '(no subject)',
    date: (m.envelope?.date ?? new Date()).toISOString(),
    unread: !(m.flags?.has('\\Seen') ?? false),
  };
}

// Most recent messages in a mailbox (default INBOX).
export async function listEmails(acc: EmailAccount, mailbox = 'INBOX', limit = 20): Promise<EmailSummary[]> {
  return withImap(acc, mailbox, async (c) => {
    const out: EmailSummary[] = [];
    const box = await c.mailboxOpen(mailbox);
    if (box.exists === 0) return out;
    const start = Math.max(1, box.exists - limit + 1);
    for await (const m of c.fetch(`${start}:*`, { uid: true, flags: true, envelope: true })) out.push(summarize(m));
    return out.reverse().slice(0, limit);
  });
}

// Search by free text (subject/body), sender, or unread flag.
export async function searchEmails(
  acc: EmailAccount,
  q: { text?: string; from?: string; subject?: string; unread?: boolean },
  mailbox = 'INBOX',
  limit = 20,
): Promise<EmailSummary[]> {
  return withImap(acc, mailbox, async (c) => {
    const query: Record<string, unknown> = {};
    if (q.text) query.body = q.text;
    if (q.from) query.from = q.from;
    if (q.subject) query.subject = q.subject;
    if (q.unread) query.seen = false;
    if (Object.keys(query).length === 0) query.all = true;
    const uids = await c.search(query, { uid: true });
    const pick = uids.slice(-limit).reverse();
    const out: EmailSummary[] = [];
    for (const uid of pick) {
      const m = await c.fetchOne(uid, { uid: true, flags: true, envelope: true }, { uid: true });
      if (m) out.push(summarize(m));
    }
    return out;
  });
}

// Full plain-text body of one message.
export async function readEmail(acc: EmailAccount, uid: number, mailbox = 'INBOX'): Promise<{ summary: EmailSummary; body: string } | null> {
  return withImap(acc, mailbox, async (c) => {
    const m = await c.fetchOne(uid, { uid: true, flags: true, envelope: true, source: true }, { uid: true });
    if (!m || !m.source) return null;
    const body = await extractPlainText(m.source);
    return { summary: summarize(m), body };
  });
}

// Move a message to another mailbox/label ("sort under the right bookmark").
export async function sortEmail(acc: EmailAccount, uid: number, toMailbox: string, fromMailbox = 'INBOX'): Promise<void> {
  await withImap(acc, fromMailbox, async (c) => {
    await c.messageMove([uid], toMailbox, { uid: true });
  });
}

// List mailboxes / Gmail labels the account can sort into.
export async function listFolders(acc: EmailAccount): Promise<string[]> {
  const client = new ImapFlow(imapConfig(acc));
  await client.connect();
  try {
    const boxes = await client.list();
    return boxes.map((b) => b.path);
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function sendEmail(acc: EmailAccount, msg: { to: string; cc?: string; subject: string; body: string }): Promise<string> {
  const t = nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpPort === 465,
    auth: { user: acc.email, pass: decrypt(acc.passwordEnc) },
  });
  const info = await t.sendMail({ from: acc.email, to: msg.to, cc: msg.cc || undefined, subject: msg.subject, text: msg.body });
  return info.messageId;
}

// Verify both IMAP login and SMTP login work with the given credentials.
export async function testConnection(acc: EmailAccount): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new ImapFlow(imapConfig(acc));
    await client.connect();
    await client.logout().catch(() => {});
    const t = nodemailer.createTransport({ host: acc.smtpHost, port: acc.smtpPort, secure: acc.smtpPort === 465, auth: { user: acc.email, pass: decrypt(acc.passwordEnc) } });
    await t.verify();
    return { ok: true };
  } catch (err) {
    logger.warn('email connection test failed', { error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

// Minimal MIME text extraction: pull the text/plain part (or strip HTML tags).
async function extractPlainText(source: Buffer): Promise<string> {
  const raw = source.toString('utf8');
  // Split headers/body on the first blank line.
  const idx = raw.indexOf('\r\n\r\n');
  const body = idx >= 0 ? raw.slice(idx + 4) : raw;
  // If multipart, grab the first text/plain section; else strip tags.
  const plainMatch = body.match(/Content-Type:\s*text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|\r\n$|$)/i);
  const text = plainMatch ? plainMatch[1] : body.replace(/<[^>]+>/g, ' ');
  return text.replace(/=\r\n/g, '').replace(/\s+\n/g, '\n').trim().slice(0, 8000);
}
