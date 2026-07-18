import { describe, it, expect } from 'vitest';
import { registerTool, toolSpecsFor, toolCatalog } from '../src/tools/registry.js';

registerTool({ name: 'tst_a', description: 'Does A. Extra detail here.', input_schema: { type: 'object' }, execute: async () => 'a' });
registerTool({ name: 'tst_b', description: `Does B ${'x'.repeat(300)}`, input_schema: { type: 'object' }, execute: async () => 'b' });

describe('tool registry', () => {
  it('toolSpecsFor dedupes and returns full schemas', () => {
    const specs = toolSpecsFor(['tst_a', 'tst_a', 'tst_b']);
    expect(specs.map((s) => s.name)).toEqual(['tst_a', 'tst_b']);
    expect(specs[0].input_schema).toBeDefined();
  });

  it('toolCatalog returns the first sentence, capped, deduped', () => {
    const cat = toolCatalog(['tst_a', 'tst_a', 'tst_b']);
    expect(cat.map((c) => c.name)).toEqual(['tst_a', 'tst_b']);
    expect(cat[0].brief).toBe('Does A.');
    expect(cat[1].brief.length).toBeLessThanOrEqual(120);
  });

  it('ignores unknown tool names', () => {
    expect(toolCatalog(['nope'])).toEqual([]);
    expect(toolSpecsFor(['nope'])).toEqual([]);
  });

  it('a catalog entry is far smaller than a full spec (the whole point)', () => {
    const spec = JSON.stringify(toolSpecsFor(['tst_b'])[0]);
    const cat = JSON.stringify(toolCatalog(['tst_b'])[0]);
    expect(cat.length).toBeLessThan(spec.length);
  });
});
