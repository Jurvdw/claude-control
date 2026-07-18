import type { Request, Response, NextFunction } from 'express';
import { SESSION_COOKIE, getSessionUser } from './session.js';

/** Populates req.user from the session cookie if present (does not reject). */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) {
    const user = await getSessionUser(sid);
    if (user) {
      req.user = user;
      req.sessionId = sid;
    }
  }
  next();
}

/** Rejects unauthenticated requests. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}
