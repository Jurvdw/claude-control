import { Router } from 'express';
import { z } from 'zod';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { encrypt } from '../lib/crypto.js';
import { testConnection } from '../lib/email.js';

export const emailRouter = Router({ mergeParams: true });

emailRouter.use(requireAuth);
emailRouter.use(requireServerMember());

// Known providers so the user only needs their email + app password.
const PRESETS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587 },
  yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  // Zoho: personal @zoho.* mailboxes use imap/smtp.zoho.*, custom-domain
  // (business) mailboxes use the "pro" hosts. Regional data centres keep the
  // same names on their own TLD — .eu here; others via the custom option.
  zoho: { imapHost: 'imap.zoho.com', imapPort: 993, smtpHost: 'smtp.zoho.com', smtpPort: 465 },
  zohopro: { imapHost: 'imappro.zoho.com', imapPort: 993, smtpHost: 'smtppro.zoho.com', smtpPort: 465 },
  zoho_eu: { imapHost: 'imap.zoho.eu', imapPort: 993, smtpHost: 'smtp.zoho.eu', smtpPort: 465 },
  zohopro_eu: { imapHost: 'imappro.zoho.eu', imapPort: 993, smtpHost: 'smtppro.zoho.eu', smtpPort: 465 },
};

// GET /servers/:serverId/email — connection status (never returns the password).
emailRouter.get('/', async (req, res, next) => {
  try {
    const acc = await prisma.emailAccount.findUnique({ where: { serverId: req.membership!.serverId } });
    if (!acc) return res.json({ connected: false });
    return res.json({ connected: true, email: acc.email, imapHost: acc.imapHost, smtpHost: acc.smtpHost });
  } catch (err) {
    next(err);
  }
});

const connectSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  provider: z.enum(['gmail', 'outlook', 'yahoo', 'icloud', 'zoho', 'zohopro', 'zoho_eu', 'zohopro_eu', 'custom']).default('gmail'),
  imapHost: z.string().optional(),
  imapPort: z.number().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().optional(),
});

// POST /servers/:serverId/email — connect a mailbox (verifies before saving).
emailRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = connectSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });
    const { email, password, provider } = body.data;
    const preset = provider !== 'custom' ? PRESETS[provider] : undefined;
    const imapHost = body.data.imapHost ?? preset?.imapHost;
    const smtpHost = body.data.smtpHost ?? preset?.smtpHost;
    if (!imapHost || !smtpHost) return res.status(400).json({ error: 'imapHost/smtpHost required for custom provider' });
    const imapPort = body.data.imapPort ?? preset?.imapPort ?? 993;
    const smtpPort = body.data.smtpPort ?? preset?.smtpPort ?? 465;

    const candidate = {
      id: 'test', serverId: req.membership!.serverId, email, imapHost, imapPort, smtpHost, smtpPort,
      secure: true, passwordEnc: encrypt(password), createdAt: new Date(), updatedAt: new Date(),
    };
    const test = await testConnection(candidate);
    if (!test.ok) return res.status(400).json({ error: `Connection failed: ${test.error}` });

    const acc = await prisma.emailAccount.upsert({
      where: { serverId: req.membership!.serverId },
      update: { email, imapHost, imapPort, smtpHost, smtpPort, passwordEnc: candidate.passwordEnc },
      create: { serverId: req.membership!.serverId, email, imapHost, imapPort, smtpHost, smtpPort, passwordEnc: candidate.passwordEnc },
    });
    return res.status(201).json({ connected: true, email: acc.email });
  } catch (err) {
    next(err);
  }
});

// DELETE /servers/:serverId/email — disconnect.
emailRouter.delete('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    await prisma.emailAccount.deleteMany({ where: { serverId: req.membership!.serverId } });
    return res.json({ connected: false });
  } catch (err) {
    next(err);
  }
});
