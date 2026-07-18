import type { Request, Response, NextFunction } from 'express';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

// Role ranking for hierarchical checks (OWNER >= ADMIN >= MEMBER).
const RANK: Record<MemberRole, number> = {
  [MemberRole.MEMBER]: 1,
  [MemberRole.ADMIN]: 2,
  [MemberRole.OWNER]: 3,
};

export function roleAtLeast(role: MemberRole, min: MemberRole): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Core tenant-isolation check. Throws if the user is not a member of the server.
 * Use everywhere a serverId is touched outside the HTTP layer (jobs, tools).
 */
export async function getMembership(userId: string, serverId: string) {
  const membership = await prisma.serverMember.findUnique({
    where: { serverId_userId: { serverId, userId } },
    select: { serverId: true, role: true },
  });
  return membership; // null if not a member
}

export class TenantError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Assert access from non-HTTP contexts (queue workers, tool execution). */
export async function assertServerAccess(
  userId: string,
  serverId: string,
  min: MemberRole = MemberRole.MEMBER,
): Promise<{ serverId: string; role: MemberRole }> {
  const membership = await getMembership(userId, serverId);
  if (!membership) throw new TenantError(404, 'server not found');
  if (!roleAtLeast(membership.role, min)) throw new TenantError(403, 'insufficient role');
  return membership;
}

/**
 * Express guard: requires the authenticated user to be a member of
 * req.params.serverId (with at least `min` role). Attaches req.membership.
 * Returns 404 (not 403) for non-members so tenants can't probe existence.
 */
export function requireServerMember(min: MemberRole = MemberRole.MEMBER) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    const serverId = req.params.serverId;
    if (!serverId) return res.status(400).json({ error: 'missing serverId' });
    const membership = await getMembership(req.user.id, serverId);
    if (!membership) return res.status(404).json({ error: 'server not found' });
    if (!roleAtLeast(membership.role, min)) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    req.membership = membership;
    next();
  };
}
