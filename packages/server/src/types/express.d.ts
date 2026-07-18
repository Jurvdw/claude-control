import type { User, MemberRole } from '@prisma/client';

// Request augmentation set by auth middleware / server guards.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
      // Set by requireServerMember: the caller's membership in :serverId.
      membership?: { serverId: string; role: MemberRole };
    }
  }
}

export {};
