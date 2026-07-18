import { describe, it, expect } from 'vitest';
import { withToolsCache, withSystemCache, withMessageCache } from '../src/llm/anthropic.js';
import type { LLMMessage, LLMToolSpec } from '../src/llm/types.js';

// Count cache_control breakpoints anywhere in a JSON value.
function countBreakpoints(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countBreakpoints(v), 0);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    let n = 'cache_control' in obj ? 1 : 0;
    for (const k of Object.keys(obj)) if (k !== 'cache_control') n += countBreakpoints(obj[k]);
    return n;
  }
  return 0;
}

const tools: LLMToolSpec[] = [
  { name: 'a', description: 'a', input_schema: { type: 'object' } },
  { name: 'b', description: 'b', input_schema: { type: 'object' } },
];

describe('prompt caching helpers', () => {
  it('caches only the last tool', () => {
    const out = withToolsCache(tools);
    expect(countBreakpoints(out)).toBe(1);
    expect(out[out.length - 1]).toHaveProperty('cache_control');
  });

  it('wraps the system string in a single cached text block', () => {
    const out = withSystemCache('you are helpful');
    expect(countBreakpoints(out)).toBe(1);
    expect(out).toEqual([
      { type: 'text', text: 'you are helpful', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('caches the last block of a string-content message', () => {
    const out = withMessageCache([{ role: 'user', content: 'hi' }]);
    expect(countBreakpoints(out)).toBe(1);
  });

  it('leaves an existing history breakpoint intact and adds the tail', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'history', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'trigger' },
        ],
      },
    ];
    const out = withMessageCache(messages);
    // history block keeps its breakpoint; the tail (trigger) gets one too.
    expect(countBreakpoints(out)).toBe(2);
  });

  it('never exceeds the 4-breakpoint API limit across a tool loop', () => {
    // Simulate the worst case: tools + system + a first user turn carrying a
    // cached history block, plus an appended assistant + tool_result turn.
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'history', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'trigger' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];
    const total =
      countBreakpoints(withToolsCache(tools)) +
      countBreakpoints(withSystemCache('sys')) +
      countBreakpoints(withMessageCache(messages));
    expect(total).toBeLessThanOrEqual(4);
  });

  it('stays within budget on the very first turn (history + trigger present)', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'history', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'trigger' },
        ],
      },
    ];
    const total =
      countBreakpoints(withToolsCache(tools)) +
      countBreakpoints(withSystemCache('sys')) +
      countBreakpoints(withMessageCache(messages));
    expect(total).toBe(4);
  });
});
