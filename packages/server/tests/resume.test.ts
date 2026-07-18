import { describe, it, expect } from 'vitest';
import { parseResetAt } from '../src/llm/subscription.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');

describe('parseResetAt — extract usage-limit reset time', () => {
  it('parses a future unix-seconds timestamp', () => {
    const ts = Math.floor(NOW.getTime() / 1000) + 3600; // +1h
    const d = parseResetAt(`usage limit reached, resets ${ts}`, NOW);
    expect(d?.getTime()).toBe(ts * 1000);
  });

  it('ignores a unix timestamp in the past', () => {
    const ts = Math.floor(NOW.getTime() / 1000) - 3600;
    expect(parseResetAt(`resets ${ts}`, NOW)).toBeUndefined();
  });

  it('parses an ISO datetime', () => {
    const d = parseResetAt('Your limit will reset at 2026-07-17T17:30:00Z.', NOW);
    expect(d?.toISOString()).toBe('2026-07-17T17:30:00.000Z');
  });

  it('parses a clock time with am/pm on the same day', () => {
    // 3:00 pm local, relative to a noon-ish "now"
    const d = parseResetAt('Your limit will reset at 3:00pm', NOW);
    expect(d).toBeDefined();
    expect(d!.getHours()).toBe(15);
    expect(d!.getMinutes()).toBe(0);
    expect(d!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('rolls a past clock time to the next day', () => {
    const early = new Date('2026-07-17T23:30:00.000Z');
    const d = parseResetAt('resets at 1:00am', early);
    expect(d).toBeDefined();
    expect(d!.getHours()).toBe(1);
    expect(d!.getTime()).toBeGreaterThan(early.getTime());
  });

  it('returns undefined when nothing is parseable', () => {
    expect(parseResetAt('you have hit your usage limit, try later', NOW)).toBeUndefined();
  });
});
