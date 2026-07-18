import { describe, it, expect } from 'vitest';
import { topoOrder, NODE_TYPES, type WFNode, type WFEdge } from '../src/workflows/engine.js';

const n = (id: string): WFNode => ({ id, type: 'agent.run' });

describe('workflow engine — topological order', () => {
  it('orders a linear chain', () => {
    const nodes = [n('a'), n('b'), n('c')];
    const edges: WFEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    expect(topoOrder(nodes, edges)).toEqual(['a', 'b', 'c']);
  });

  it('puts a node after all its dependencies (diamond)', () => {
    const nodes = [n('a'), n('b'), n('c'), n('d')];
    const edges: WFEdge[] = [
      { source: 'a', target: 'b' }, { source: 'a', target: 'c' },
      { source: 'b', target: 'd' }, { source: 'c', target: 'd' },
    ];
    const order = topoOrder(nodes, edges)!;
    expect(order).not.toBeNull();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('returns null on a cycle', () => {
    const nodes = [n('a'), n('b')];
    const edges: WFEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }];
    expect(topoOrder(nodes, edges)).toBeNull();
  });

  it('handles isolated nodes', () => {
    const order = topoOrder([n('a'), n('b')], []);
    expect(order?.sort()).toEqual(['a', 'b']);
  });

  it('exposes the new node types', () => {
    expect(NODE_TYPES).toContain('http.request');
    expect(NODE_TYPES).toContain('delay');
    expect(NODE_TYPES).toContain('condition');
  });
});
