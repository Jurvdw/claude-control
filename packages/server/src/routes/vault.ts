import { Router } from 'express';
import { z } from 'zod';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { vaultAdd, invalidateVault, redact, restore } from '../lib/privacy.js';
import { decrypt } from '../lib/crypto.js';

export const vaultRouter = Router({ mergeParams: true });

vaultRouter.use(requireAuth);
vaultRouter.use(requireServerMember());

// Real values are returned masked. The whole point of this table is that these
// strings stay off the wire; echoing them back through the API would undo that.
function mask(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

vaultRouter.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.vaultEntry.findMany({
      where: { serverId: req.membership!.serverId },
      orderBy: [{ hits: 'desc' }, { createdAt: 'asc' }],
    });
    return res.json({
      entries: rows.map((r) => {
        let preview = '••••';
        try {
          preview = mask(decrypt(r.valueEnc));
        } catch {
          preview = '(unreadable — key changed)';
        }
        return { id: r.id, token: r.token, label: r.label, kind: r.kind, auto: r.auto, hits: r.hits, preview };
      }),
    });
  } catch (err) {
    next(err);
  }
});

const addSchema = z.object({
  value: z.string().min(1).max(500),
  label: z.string().max(200).optional(),
  kind: z.enum(['custom', 'email', 'phone', 'iban', 'card']).optional(),
});

vaultRouter.post('/', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = addSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body' });
    const token = await vaultAdd(req.membership!.serverId, body.data.value, {
      label: body.data.label,
      kind: body.data.kind ?? 'custom',
    });
    return res.status(201).json({ token });
  } catch (err) {
    next(err);
  }
});

vaultRouter.delete('/:id', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const existing = await prisma.vaultEntry.findFirst({ where: { id: req.params.id, serverId: req.membership!.serverId } });
    if (!existing) return res.status(404).json({ error: 'not found' });
    await prisma.vaultEntry.delete({ where: { id: existing.id } });
    invalidateVault(req.membership!.serverId);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Dry-run: show exactly what the model would receive for a given text, and that
// it comes back intact. Redaction is invisible by nature — without a way to see
// it, users cannot tell a working safety net from a broken one.
vaultRouter.post('/preview', async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? '').slice(0, 5000);
    if (!text) return res.status(400).json({ error: 'text required' });
    const settings = (await prisma.server.findUnique({ where: { id: req.membership!.serverId }, select: { settings: true } }))?.settings ?? {};
    const s = settings as { redactionEnabled?: boolean; autoDetect?: boolean };
    // Preview always redacts, even when the feature is off, so it can be used to
    // decide whether to turn it on.
    const redacted = await redact(req.membership!.serverId, text, { redactionEnabled: true, autoDetect: s.autoDetect ?? true });
    invalidateVault(req.membership!.serverId);
    return res.json({ redacted, restored: await restore(req.membership!.serverId, redacted), enabled: !!s.redactionEnabled });
  } catch (err) {
    next(err);
  }
});
