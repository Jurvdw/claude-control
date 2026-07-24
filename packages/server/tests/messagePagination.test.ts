import { describe, it, expect } from 'vitest';
import { buildRecentMessagesArgs, toChronological } from '../src/lib/messagePagination.js';

describe('buildRecentMessagesArgs', () => {
  it('orders DESC so the newest messages come back first, not the oldest', () => {
    const args = buildRecentMessagesArgs({ channelId: 'c1', serverId: 's1' }, undefined, 50, { id: true });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('takes exactly `limit` rows', () => {
    const args = buildRecentMessagesArgs({ channelId: 'c1', serverId: 's1' }, undefined, 50, { id: true });
    expect(args.take).toBe(50);
  });

  it('applies no createdAt filter when no cursor is given (initial load)', () => {
    const args = buildRecentMessagesArgs({ channelId: 'c1', serverId: 's1' }, undefined, 50, { id: true });
    expect(args.where).toEqual({ channelId: 'c1', serverId: 's1' });
  });

  it('filters to strictly-older-than-cursor when a `before` cursor is given', () => {
    const before = '2026-07-20T12:00:00.000Z';
    const args = buildRecentMessagesArgs({ channelId: 'c1', serverId: 's1' }, before, 50, { id: true });
    expect(args.where).toEqual({
      channelId: 'c1',
      serverId: 's1',
      createdAt: { lt: new Date(before) },
    });
  });

  it('preserves the base where clause fields (works identically for channel and DM callers)', () => {
    const args = buildRecentMessagesArgs({ dmThreadId: 't1', serverId: 's1' }, undefined, 50, { id: true });
    expect(args.where).toEqual({ dmThreadId: 't1', serverId: 's1' });
  });

  it('passes the select clause through unchanged', () => {
    const select = { id: true, content: true };
    const args = buildRecentMessagesArgs({ channelId: 'c1', serverId: 's1' }, undefined, 50, select);
    expect(args.select).toBe(select);
  });
});

describe('toChronological', () => {
  it('reverses DESC-ordered rows back to ascending (oldest-first) order', () => {
    const desc = [{ id: 'newest' }, { id: 'mid' }, { id: 'oldest' }];
    expect(toChronological(desc)).toEqual([{ id: 'oldest' }, { id: 'mid' }, { id: 'newest' }]);
  });

  it('does not mutate the input array', () => {
    const desc = [{ id: 'a' }, { id: 'b' }];
    const original = [...desc];
    toChronological(desc);
    expect(desc).toEqual(original);
  });

  it('handles an empty array', () => {
    expect(toChronological([])).toEqual([]);
  });

  it('handles a single-element array', () => {
    expect(toChronological([{ id: 'only' }])).toEqual([{ id: 'only' }]);
  });
});
