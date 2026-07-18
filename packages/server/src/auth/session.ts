import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { randomToken } from '../lib/crypto.js';
import { isProd } from '../config/env.js';

export const SESSION_COOKIE = 'cc_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export async function createSession(userId: string): Promise<string> {
  const id = randomToken(32);
  await prisma.session.create({
    data: { id, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  return id;
}

export async function getSessionUser(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.user;
}

export async function destroySession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
