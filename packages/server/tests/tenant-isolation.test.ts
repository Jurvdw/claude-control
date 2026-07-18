import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { PrismaClient, MemberRole } from '@prisma/client';
import { getMembership, assertServerAccess, TenantError } from '../src/auth/guards.js';

const prisma = new PrismaClient();

// Test helper to hash password (simple approach for testing)
async function hashPassword(password: string): Promise<string> {
  // Using argon2 would be better, but for test isolation, a simple hash is fine
  // In production, this is handled by src/auth code
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Check if database is available before running tests
let dbAvailable = false;

describe(
  'tenant isolation',
  () => {
    let userId1: string | undefined;
    let userId2: string | undefined;
    let serverId1: string | undefined;
    let serverId2: string | undefined;

    beforeAll(async () => {
      // Attempt to connect to the database
      try {
        await prisma.$connect();
        dbAvailable = true;
      } catch (e) {
        console.warn(
          '⚠️  Postgres not available. To run tenant-isolation tests:\n' +
            '  docker compose up -d postgres\n' +
            '  npm run db:migrate',
        );
        dbAvailable = false;
        return;
      }

      // Create two users
      const passwordHash1 = await hashPassword('password1');
      const passwordHash2 = await hashPassword('password2');

      const user1 = await prisma.user.create({
        data: {
          email: `test-user-1-${Date.now()}@example.com`,
          displayName: 'Test User 1',
          passwordHash: passwordHash1,
        },
      });
      userId1 = user1.id;

      const user2 = await prisma.user.create({
        data: {
          email: `test-user-2-${Date.now()}@example.com`,
          displayName: 'Test User 2',
          passwordHash: passwordHash2,
        },
      });
      userId2 = user2.id;

      // Create two servers, each owned by a different user
      const server1 = await prisma.server.create({
        data: {
          name: 'Server 1',
          ownerId: userId1,
          members: {
            create: {
              userId: userId1,
              role: MemberRole.OWNER,
            },
          },
        },
      });
      serverId1 = server1.id;

      const server2 = await prisma.server.create({
        data: {
          name: 'Server 2',
          ownerId: userId2,
          members: {
            create: {
              userId: userId2,
              role: MemberRole.OWNER,
            },
          },
        },
      });
      serverId2 = server2.id;
    });

    afterAll(async () => {
      // Clean up: delete all created rows (only if they were created)
      try {
        if (userId1 && userId2) {
          await prisma.serverMember.deleteMany({
            where: {
              userId: { in: [userId1, userId2] },
            },
          });
        }

        if (serverId1 && serverId2) {
          await prisma.server.deleteMany({
            where: {
              id: { in: [serverId1, serverId2] },
            },
          });
        }

        if (userId1 && userId2) {
          await prisma.user.deleteMany({
            where: {
              id: { in: [userId1, userId2] },
            },
          });
        }
      } catch (e) {
        console.error('Cleanup error:', e);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('should prevent user A from accessing server B (getMembership returns null)', async () => {
      if (!dbAvailable) {
        console.log('⏭️  Skipping (Postgres unavailable)');
        return;
      }
      const membership = await getMembership(userId1!, serverId2!);
      expect(membership).toBeNull();
    });

    it('should allow user A to access server A (getMembership returns membership)', async () => {
      if (!dbAvailable) {
        console.log('⏭️  Skipping (Postgres unavailable)');
        return;
      }
      const membership = await getMembership(userId1!, serverId1!);
      expect(membership).not.toBeNull();
      expect(membership?.serverId).toBe(serverId1!);
      expect(membership?.role).toBe(MemberRole.OWNER);
    });

    it('should throw TenantError when accessing another user server via assertServerAccess', async () => {
      if (!dbAvailable) {
        console.log('⏭️  Skipping (Postgres unavailable)');
        return;
      }
      let thrown = false;
      try {
        await assertServerAccess(userId1!, serverId2!);
      } catch (e) {
        thrown = true;
        expect(e).toBeInstanceOf(TenantError);
        const err = e as TenantError;
        expect(err.status).toBe(404);
        expect(err.message).toContain('server not found');
      }
      expect(thrown).toBe(true);
    });

    it('should succeed when accessing own server via assertServerAccess', async () => {
      if (!dbAvailable) {
        console.log('⏭️  Skipping (Postgres unavailable)');
        return;
      }
      const result = await assertServerAccess(userId1!, serverId1!);
      expect(result.serverId).toBe(serverId1!);
      expect(result.role).toBe(MemberRole.OWNER);
    });

    it('should enforce role-based access control in assertServerAccess', async () => {
      if (!dbAvailable) {
        console.log('⏭️  Skipping (Postgres unavailable)');
        return;
      }
      // Create an admin user on server1
      const adminUser = await prisma.user.create({
        data: {
          email: `test-admin-${Date.now()}@example.com`,
          displayName: 'Test Admin',
          passwordHash: await hashPassword('adminpass'),
        },
      });

      try {
        await prisma.serverMember.create({
          data: {
            serverId: serverId1,
            userId: adminUser.id,
            role: MemberRole.ADMIN,
          },
        });

        // Admin can access as MEMBER
        const result = await assertServerAccess(adminUser.id, serverId1, MemberRole.MEMBER);
        expect(result.role).toBe(MemberRole.ADMIN);

        // Admin can access as ADMIN
        const resultAdmin = await assertServerAccess(adminUser.id, serverId1, MemberRole.ADMIN);
        expect(resultAdmin.role).toBe(MemberRole.ADMIN);

        // Admin cannot access as OWNER
        let thrown = false;
        try {
          await assertServerAccess(adminUser.id, serverId1, MemberRole.OWNER);
        } catch (e) {
          thrown = true;
          expect(e).toBeInstanceOf(TenantError);
          const err = e as TenantError;
          expect(err.status).toBe(403);
          expect(err.message).toContain('insufficient role');
        }
        expect(thrown).toBe(true);
      } finally {
        // Cleanup admin user
        await prisma.serverMember.deleteMany({
          where: { userId: adminUser.id },
        });
        await prisma.user.delete({
          where: { id: adminUser.id },
        });
      }
    });
  },
);
