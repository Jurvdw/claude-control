import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';

// Set ENCRYPTION_KEY before importing the module
const validKey = crypto.randomBytes(32).toString('base64');
process.env.ENCRYPTION_KEY = validKey;

// Now import after env is set
import { encrypt, decrypt, randomToken } from '../src/lib/crypto.js';

describe('crypto module', () => {
  describe('encrypt/decrypt round-trip', () => {
    it('should round-trip plaintext to ciphertext and back', () => {
      const plaintext = 'my-secret-key-12345';
      const ciphertext = encrypt(plaintext);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle unicode characters', () => {
      const plaintext = '你好世界 🌍 Привет мир';
      const ciphertext = encrypt(plaintext);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings', () => {
      const plaintext = 'a'.repeat(10000);
      const ciphertext = encrypt(plaintext);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle empty strings', () => {
      const plaintext = '';
      const ciphertext = encrypt(plaintext);
      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('ciphertext properties', () => {
    it('should produce different ciphertext for same plaintext (random IV)', () => {
      const plaintext = 'test-message';
      const ct1 = encrypt(plaintext);
      const ct2 = encrypt(plaintext);
      // Ciphertexts should differ due to random IV
      expect(ct1).not.toBe(ct2);
    });

    it('ciphertext should differ from plaintext', () => {
      const plaintext = 'my-secret';
      const ciphertext = encrypt(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      // Also check that plaintext is not contained in ciphertext (base64 encoded)
      expect(ciphertext).not.toContain(plaintext);
    });
  });

  describe('tampering detection', () => {
    it('should throw when auth tag is tampered', () => {
      const plaintext = 'original';
      const ciphertext = encrypt(plaintext);
      // Flip a bit in the auth tag area (bytes 12-28)
      const tampered = Buffer.from(ciphertext, 'base64');
      tampered[15] ^= 0xff; // Flip bits in auth tag
      const tamperedB64 = tampered.toString('base64');
      expect(() => decrypt(tamperedB64)).toThrow();
    });

    it('should throw when ciphertext payload is tampered', () => {
      const plaintext = 'original';
      const ciphertext = encrypt(plaintext);
      // Flip a bit in the ciphertext payload (after tag)
      const tampered = Buffer.from(ciphertext, 'base64');
      if (tampered.length > 30) {
        tampered[30] ^= 0xff; // Flip bits in ciphertext
      }
      const tamperedB64 = tampered.toString('base64');
      expect(() => decrypt(tamperedB64)).toThrow();
    });

    it('should throw when IV is tampered', () => {
      const plaintext = 'original';
      const ciphertext = encrypt(plaintext);
      // Flip a bit in the IV area (bytes 0-12)
      const tampered = Buffer.from(ciphertext, 'base64');
      tampered[0] ^= 0xff; // Flip bits in IV
      const tamperedB64 = tampered.toString('base64');
      expect(() => decrypt(tamperedB64)).toThrow();
    });
  });

  describe('randomToken', () => {
    it('should generate a random token', () => {
      const token = randomToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('should generate different tokens on each call', () => {
      const token1 = randomToken();
      const token2 = randomToken();
      expect(token1).not.toBe(token2);
    });

    it('should respect the bytes parameter', () => {
      const token32 = randomToken(32);
      const token24 = randomToken(24);
      // base64url encoding: ceil(bytes * 4 / 3)
      // 32 bytes -> ~43 chars, 24 bytes -> ~32 chars
      expect(token32.length).toBeGreaterThan(token24.length);
    });

    it('should be URL-safe (base64url)', () => {
      const token = randomToken();
      // base64url uses - and _ instead of + and /
      expect(/^[A-Za-z0-9_-]*$/.test(token)).toBe(true);
    });
  });
});
