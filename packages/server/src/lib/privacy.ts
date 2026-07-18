import { createHmac } from 'node:crypto';
import { prisma } from './prisma.js';
import { encrypt, decrypt } from './crypto.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Data safety net: sensitive values are swapped for placeholders on the way to
 * the model and swapped back on the way out, so Anthropic sees <EMAIL_2> where
 * the conversation says alice@acme.com.
 *
 * Two directions, and BOTH are required for the feature to be usable:
 *
 *   redact()  — everything outbound: system prompt, transcript, tool results.
 *   restore() — the model's tool INPUTS (so send_email actually gets the real
 *               address) and its final reply (so the user reads real values).
 *
 * Restoring tool inputs is the part that makes this a redaction layer rather
 * than a way to break every integration: the model reasons over placeholders,
 * but the tools it calls run against reality.
 *
 * Mappings are persistent per workspace, because a value redacted in one run
 * must map to the same token in the next — otherwise the model sees a different
 * name for the same customer every turn, and output restoration fails whenever
 * a token outlives the run that created it.
 *
 * WHAT THIS IS NOT: a security boundary. It removes what it can recognise —
 * vault entries and well-formed emails/phones/IBANs/cards. Free-text secrets it
 * has never been told about (a name in a paragraph, an address, a case detail)
 * still go to the model. Treat it as a way to keep known-sensitive identifiers
 * out of prompts, not as a guarantee that nothing sensitive leaves.
 */

export interface PrivacySettings {
  /** Master switch. Off → redact/restore are no-ops. */
  redactionEnabled?: boolean;
  /** Auto-detect well-formed identifiers in addition to vault entries. */
  autoDetect?: boolean;
}

const KIND_PREFIX: Record<string, string> = {
  custom: 'DATA',
  email: 'EMAIL',
  phone: 'PHONE',
  iban: 'IBAN',
  card: 'CARD',
};

// Deliberately conservative: a pattern that over-matches silently corrupts
// ordinary text (and a redaction users can't predict is worse than none).
const DETECTORS: Array<{ kind: string; re: RegExp; normalise?: (s: string) => string }> = [
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // IBAN before phone: an IBAN contains long digit runs a phone pattern would eat.
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, normalise: (s) => s.replace(/\s+/g, '').toUpperCase() },
  { kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, normalise: (s) => s.replace(/[ -]/g, '') },
  // Phones need a POSITIVE signal — a leading +country-code, or digit groups
  // actually separated by spaces/dashes/parens. Matching bare digit runs turned
  // "order 1234567890123456" into "order 1234<PHONE_1>": a false positive here
  // silently corrupts ordinary text, while a false negative just means the user
  // adds the number to the vault by hand. Bias hard toward missing one.
  {
    kind: 'phone',
    re: /(?:\+\d{1,3}[\s-]?(?:\(?\d{1,4}\)?[\s-]?){1,4}\d{2,4}|\b\d{2,4}[\s-]\d{2,4}[\s-]\d{2,4}(?:[\s-]\d{2,4})?\b)/g,
    normalise: (s) => s.replace(/[\s-()]/g, ''),
  },
];

/** Luhn check — without it, any 16-digit order number reads as a card number. */
function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Stable, non-reversible lookup key. Lets us find an entry without decrypting. */
function fingerprint(value: string): string {
  return createHmac('sha256', env.ENCRYPTION_KEY).update(value.trim().toLowerCase()).digest('hex');
}

interface Entry {
  token: string;
  value: string;
}

// Per-server cache of the decrypted vault. Redaction runs on every message of
// every run, so re-reading and re-decrypting the table each time would be the
// single hottest query in the app.
const cache = new Map<string, { entries: Entry[]; at: number }>();
const TTL_MS = 30_000;

export function invalidateVault(serverId: string): void {
  cache.delete(serverId);
}

async function loadVault(serverId: string): Promise<Entry[]> {
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.entries;

  const rows = await prisma.vaultEntry.findMany({ where: { serverId }, select: { token: true, valueEnc: true } });
  const entries: Entry[] = [];
  for (const r of rows) {
    try {
      entries.push({ token: r.token, value: decrypt(r.valueEnc) });
    } catch {
      // A value encrypted under a previous ENCRYPTION_KEY can't be recovered.
      // Skipping beats throwing: one bad row must not block every agent run.
      logger.warn('vault entry could not be decrypted; skipping', { token: r.token });
    }
  }
  // Longest first, so a value that contains another (an email inside a signature
  // block, a full number inside a longer one) is replaced before its substring.
  entries.sort((a, b) => b.value.length - a.value.length);
  cache.set(serverId, { entries, at: Date.now() });
  return entries;
}

/** Next free token for a kind, e.g. <EMAIL_3>. */
async function mintToken(serverId: string, kind: string): Promise<string> {
  const prefix = KIND_PREFIX[kind] ?? 'DATA';
  const existing = await prisma.vaultEntry.count({ where: { serverId, kind } });
  // count+1 can collide if a row was deleted; walk forward until free.
  for (let n = existing + 1; n < existing + 500; n++) {
    const token = `<${prefix}_${n}>`;
    const clash = await prisma.vaultEntry.findFirst({ where: { serverId, token }, select: { id: true } });
    if (!clash) return token;
  }
  return `<${prefix}_${Date.now()}>`;
}

/** Add a value to the vault (or return the existing token for it). */
export async function vaultAdd(
  serverId: string,
  value: string,
  opts: { kind?: string; label?: string; auto?: boolean; matchOn?: string } = {},
): Promise<string> {
  const clean = value.trim();
  if (!clean) throw new Error('empty value');
  // `matchOn` lets identity and stored text differ: a phone written
  // "+31 6 12 34 56 78" and "+31612345678" must collapse to ONE token (identity
  // = normalised), while restore has to give back the formatting the user
  // actually wrote (stored = raw). Fingerprinting the stored text instead would
  // mint a second token for every way of typing the same number.
  const fp = fingerprint(opts.matchOn ?? clean);
  const existing = await prisma.vaultEntry.findFirst({ where: { serverId, fingerprint: fp }, select: { token: true } });
  if (existing) return existing.token;

  const kind = opts.kind ?? 'custom';
  const token = await mintToken(serverId, kind);
  try {
    await prisma.vaultEntry.create({
      data: { serverId, token, valueEnc: encrypt(clean), fingerprint: fp, label: opts.label ?? null, kind, auto: opts.auto ?? false },
    });
  } catch (err) {
    // Two concurrent runs can detect the same value at once; the unique index
    // catches it and we reuse whatever landed first.
    const raced = await prisma.vaultEntry.findFirst({ where: { serverId, fingerprint: fp }, select: { token: true } });
    if (raced) return raced.token;
    throw err;
  }
  invalidateVault(serverId);
  return token;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every known sensitive value in `text` with its token. Auto-detected
 * values are added to the vault as they're found, so the mapping is reversible
 * later — a token we cannot map back is worse than not redacting at all.
 */
export async function redact(serverId: string, text: string, settings: PrivacySettings): Promise<string> {
  if (!settings.redactionEnabled || !text) return text;
  let out = text;

  // Curated entries FIRST. They are the user's explicit intent, and they are
  // often longer than what a detector would grab from the same span — running
  // detection first let the phone pattern eat the digits out of a vault entry
  // like "Klant 10958736479" before the entry itself could ever match.
  const entries = await loadVault(serverId);
  for (const e of entries) {
    if (!e.value) continue;
    if (out.includes(e.value)) {
      out = out.split(e.value).join(e.token);
      continue;
    }
    const re = new RegExp(escapeRe(e.value), 'gi');
    if (re.test(out)) out = out.replace(re, e.token);
  }

  // Then detectors, over whatever is left.
  if (settings.autoDetect) {
    for (const det of DETECTORS) {
      const found = out.match(det.re);
      if (!found) continue;
      for (const raw of new Set(found)) {
        const normalised = det.normalise ? det.normalise(raw) : raw;
        if (det.kind === 'card' && !luhnValid(normalised)) continue;
        if (det.kind === 'phone' && normalised.replace(/\D/g, '').length < 7) continue;
        try {
          // Store what was written, match on the normalised form.
          const token = await vaultAdd(serverId, raw, { kind: det.kind, auto: true, label: `auto-detected ${det.kind}`, matchOn: normalised });
          out = out.split(raw).join(token);
        } catch {
          /* never let redaction failure break a run */
        }
      }
    }
  }
  return out;
}

/** Swap tokens back to real values. Safe to call when redaction is off. */
export async function restore(serverId: string, text: string): Promise<string> {
  if (!text || !text.includes('<')) return text;
  const entries = await loadVault(serverId);
  let out = text;
  for (const e of entries) {
    if (out.includes(e.token)) out = out.split(e.token).join(e.value);
  }
  return out;
}

/** Restore every string inside a tool-call argument object, recursively. */
export async function restoreDeep(serverId: string, input: unknown): Promise<unknown> {
  if (typeof input === 'string') return restore(serverId, input);
  if (Array.isArray(input)) return Promise.all(input.map((v) => restoreDeep(serverId, v)));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = await restoreDeep(serverId, v);
    return out;
  }
  return input;
}

/** Count redactions for the activity/settings view. */
export async function bumpHits(serverId: string, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await prisma.vaultEntry.updateMany({ where: { serverId, token: { in: tokens } }, data: { hits: { increment: 1 } } });
}

/** Tokens present in a piece of text (used for hit counting + tests). */
export function tokensIn(text: string): string[] {
  return [...new Set(text.match(/<[A-Z]+_\d+>/g) ?? [])];
}
