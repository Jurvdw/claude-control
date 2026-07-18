import { describe, it, expect, vi, beforeEach } from 'vitest';

// The vault is exercised against an in-memory stand-in for Prisma: these tests
// are about the redact/restore contract, not about the database.
const rows: Array<{ id: string; serverId: string; token: string; valueEnc: string; fingerprint: string; kind: string; hits: number }> = [];

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    vaultEntry: {
      findMany: async ({ where }: never) => rows.filter((r) => r.serverId === (where as { serverId: string }).serverId),
      findFirst: async ({ where }: never) => {
        const w = where as { serverId: string; fingerprint?: string; token?: string };
        return rows.find(
          (r) => r.serverId === w.serverId && (w.fingerprint ? r.fingerprint === w.fingerprint : true) && (w.token ? r.token === w.token : true),
        ) ?? null;
      },
      count: async ({ where }: never) => {
        const w = where as { serverId: string; kind?: string };
        return rows.filter((r) => r.serverId === w.serverId && (w.kind ? r.kind === w.kind : true)).length;
      },
      create: async ({ data }: never) => {
        const d = data as (typeof rows)[number];
        rows.push({ ...d, id: String(rows.length + 1), hits: 0 });
        return d;
      },
      updateMany: async () => ({ count: 0 }),
    },
  },
}));

// Real AES round-trip would need a configured key; identity keeps the test on topic.
vi.mock('../src/lib/crypto.js', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

const { redact, restore, restoreDeep, vaultAdd, invalidateVault, tokensIn } = await import('../src/lib/privacy.js');

const S = 'srv1';
const ON = { redactionEnabled: true, autoDetect: true };

beforeEach(() => {
  rows.length = 0;
  invalidateVault(S);
});

describe('redaction round-trip', () => {
  it('is a no-op when disabled — the safety net must be opt-in, not silent', async () => {
    const text = 'mail alice@acme.com';
    expect(await redact(S, text, { redactionEnabled: false, autoDetect: true })).toBe(text);
  });

  it('replaces a curated vault value and restores it exactly', async () => {
    await vaultAdd(S, 'Klant 10958736479', { label: 'big client' });
    invalidateVault(S);
    const red = await redact(S, 'Please invoice Klant 10958736479 today', ON);
    expect(red).not.toContain('10958736479');
    expect(red).toMatch(/<DATA_1>/);
    expect(await restore(S, red)).toBe('Please invoice Klant 10958736479 today');
  });

  it('auto-detects an email and keeps the mapping reversible', async () => {
    const red = await redact(S, 'write to alice@acme.com about the order', ON);
    expect(red).not.toContain('alice@acme.com');
    expect(await restore(S, red)).toContain('alice@acme.com');
  });

  it('gives the same value the same token across separate calls', async () => {
    const a = await redact(S, 'alice@acme.com', ON);
    invalidateVault(S);
    const b = await redact(S, 'ping alice@acme.com again', ON);
    expect(tokensIn(a)[0]).toBe(tokensIn(b)[0]);
  });

  it('restores tool arguments recursively, so integrations get real values', async () => {
    await redact(S, 'alice@acme.com', ON); // seeds the vault
    invalidateVault(S);
    const token = rows[0].token;
    const restored = (await restoreDeep(S, { to: token, meta: { cc: [token] }, count: 3 })) as {
      to: string;
      meta: { cc: string[] };
      count: number;
    };
    expect(restored.to).toBe('alice@acme.com');
    expect(restored.meta.cc[0]).toBe('alice@acme.com');
    expect(restored.count).toBe(3); // non-strings pass through untouched
  });

  it('does not mistake an ordinary long number for a credit card', async () => {
    // Fails Luhn — an order number, not a card.
    const red = await redact(S, 'order 1234567890123456 shipped', ON);
    expect(red).toContain('1234567890123456');
  });

  it('redacts a Luhn-valid card number', async () => {
    const red = await redact(S, 'card 4242424242424242 on file', ON);
    expect(red).not.toContain('4242424242424242');
  });

  it('prefers the longest match so one value cannot eat another', async () => {
    await vaultAdd(S, 'Acme');
    await vaultAdd(S, 'Acme Industries BV');
    invalidateVault(S);
    const red = await redact(S, 'invoice Acme Industries BV now', ON);
    // The longer entry must win; the short one must not shred it first.
    expect(await restore(S, red)).toBe('invoice Acme Industries BV now');
  });
});
