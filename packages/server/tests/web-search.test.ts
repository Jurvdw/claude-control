import { describe, it, expect } from 'vitest';
import { buildToolsParam } from '../src/llm/anthropic.js';
import type { LLMToolSpec } from '../src/llm/types.js';

// web_search is a capability FLAG in our registry, not a callable tool. If it
// ever reaches the API as a normal tool definition the model tries to call it
// client-side and the run stalls — so these tests pin the translation.

const spec = (name: string): LLMToolSpec => ({
  name,
  description: name,
  input_schema: { type: 'object' },
});

function find(tools: unknown[], name: string) {
  return tools.find((t) => (t as { name?: string }).name === name) as
    | Record<string, unknown>
    | undefined;
}

describe('web_search → server-side tool (API-key mode)', () => {
  it('never sends web_search as a client tool', () => {
    const out = buildToolsParam([spec('send_message'), spec('web_search')], 'claude-opus-4-8');
    const search = find(out, 'web_search');
    // Presence of `type` marks it as an Anthropic server tool; a client tool
    // would carry input_schema instead.
    expect(search).toHaveProperty('type');
    expect(search).not.toHaveProperty('input_schema');
  });

  it('leaves the client tools untouched alongside it', () => {
    const out = buildToolsParam([spec('send_message'), spec('web_search')], 'claude-opus-4-8');
    expect(out).toHaveLength(2);
    expect(find(out, 'send_message')).toHaveProperty('input_schema');
  });

  it('omits the server tool entirely when the agent lacks the capability', () => {
    const out = buildToolsParam([spec('send_message')], 'claude-opus-4-8');
    expect(find(out, 'web_search')).toBeUndefined();
  });

  it('grants search to an agent that has no client tools at all', () => {
    const out = buildToolsParam([spec('web_search')], 'claude-opus-4-8');
    expect(out).toHaveLength(1);
    expect(find(out, 'web_search')).toHaveProperty('type', 'web_search_20260209');
  });

  // Dynamic filtering (_20260209) requires Opus 4.6+ / Sonnet 4.6+. Sending it
  // to Haiku 4.5 is a 400, which would break every Haiku agent granted search.
  it('falls back to the basic variant on Haiku', () => {
    const out = buildToolsParam([spec('web_search')], 'claude-haiku-4-5');
    expect(find(out, 'web_search')).toHaveProperty('type', 'web_search_20250305');
  });

  it('uses dynamic filtering on Sonnet and Opus', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-8']) {
      const out = buildToolsParam([spec('web_search')], model);
      expect(find(out, 'web_search')).toHaveProperty('type', 'web_search_20260209');
    }
  });

  it('keeps exactly one cache breakpoint, on the last client tool', () => {
    const out = buildToolsParam(
      [spec('a'), spec('b'), spec('web_search')],
      'claude-opus-4-8',
    );
    const cached = out.filter((t) => 'cache_control' in (t as object));
    expect(cached).toHaveLength(1);
    expect(cached[0]).toHaveProperty('name', 'b');
  });
});
