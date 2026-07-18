import crypto from 'node:crypto';
import { env } from '../config/env.js';

// AES-256-GCM encryption for secrets at rest (Anthropic API keys).
// Storage format (base64): [12-byte IV][16-byte auth tag][ciphertext].

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Cryptographically random token (URL-safe), used for sessions & invites. */
export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
