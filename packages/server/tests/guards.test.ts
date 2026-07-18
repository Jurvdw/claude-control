import { describe, it, expect } from 'vitest';
import { MemberRole } from '@prisma/client';
import { roleAtLeast } from '../src/auth/guards.js';

describe('guards module', () => {
  describe('roleAtLeast', () => {
    describe('MEMBER role', () => {
      it('should pass MEMBER >= MEMBER', () => {
        expect(roleAtLeast(MemberRole.MEMBER, MemberRole.MEMBER)).toBe(true);
      });

      it('should fail MEMBER >= ADMIN', () => {
        expect(roleAtLeast(MemberRole.MEMBER, MemberRole.ADMIN)).toBe(false);
      });

      it('should fail MEMBER >= OWNER', () => {
        expect(roleAtLeast(MemberRole.MEMBER, MemberRole.OWNER)).toBe(false);
      });
    });

    describe('ADMIN role', () => {
      it('should pass ADMIN >= MEMBER', () => {
        expect(roleAtLeast(MemberRole.ADMIN, MemberRole.MEMBER)).toBe(true);
      });

      it('should pass ADMIN >= ADMIN', () => {
        expect(roleAtLeast(MemberRole.ADMIN, MemberRole.ADMIN)).toBe(true);
      });

      it('should fail ADMIN >= OWNER', () => {
        expect(roleAtLeast(MemberRole.ADMIN, MemberRole.OWNER)).toBe(false);
      });
    });

    describe('OWNER role', () => {
      it('should pass OWNER >= MEMBER', () => {
        expect(roleAtLeast(MemberRole.OWNER, MemberRole.MEMBER)).toBe(true);
      });

      it('should pass OWNER >= ADMIN', () => {
        expect(roleAtLeast(MemberRole.OWNER, MemberRole.ADMIN)).toBe(true);
      });

      it('should pass OWNER >= OWNER', () => {
        expect(roleAtLeast(MemberRole.OWNER, MemberRole.OWNER)).toBe(true);
      });
    });

    it('should correctly rank all combinations', () => {
      const ranking = {
        [MemberRole.MEMBER]: 1,
        [MemberRole.ADMIN]: 2,
        [MemberRole.OWNER]: 3,
      };

      const roles = [MemberRole.MEMBER, MemberRole.ADMIN, MemberRole.OWNER];

      for (const role of roles) {
        for (const min of roles) {
          const expected = ranking[role] >= ranking[min];
          expect(roleAtLeast(role, min)).toBe(
            expected,
            `roleAtLeast(${role}, ${min}) should be ${expected}`,
          );
        }
      }
    });
  });
});
