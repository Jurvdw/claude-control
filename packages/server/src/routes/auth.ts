import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, destroySession, setSessionCookie, clearSessionCookie } from '../auth/session.js';
import { requireAuth } from '../auth/middleware.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body' });

    const { email, password, displayName } = body.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'email already in use' });

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, displayName },
      select: { id: true, email: true, displayName: true, avatarUrl: true, onboardedAt: true, createdAt: true },
    });

    const sid = await createSession(user.id);
    setSessionCookie(res, sid);
    return res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const { email, password } = body.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'invalid credentials' });

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    const sid = await createSession(user.id);
    setSessionCookie(res, sid);
    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        onboardedAt: user.onboardedAt,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    if (req.sessionId) await destroySession(req.sessionId);
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = req.user!;
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      onboardedAt: user.onboardedAt,
      createdAt: user.createdAt,
    },
  });
});

authRouter.post('/onboarding-complete', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { onboardedAt: new Date() },
      select: { id: true, email: true, displayName: true, avatarUrl: true, onboardedAt: true, createdAt: true },
    });
    return res.json({ user });
  } catch (err) {
    next(err);
  }
});
