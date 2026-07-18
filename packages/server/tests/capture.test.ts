import { describe, it, expect } from 'vitest';
import { CANON } from '../src/tools/capture.js';

// The token cost of proactive capture is the Brain index, which carries one line
// per note in every agent's system prompt. The taxonomy is what bounds it.
describe('capture taxonomy', () => {
  it('is a small fixed set — capture can never grow the Brain index without bound', () => {
    const kinds = Object.keys(CANON);
    expect(kinds.length).toBeLessThanOrEqual(6);
  });

  it('maps every kind to a distinct canonical note', () => {
    const paths = Object.values(CANON).map((c) => `${c.folder}/${c.title}`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every note a summary (the line that ships in every prompt)', () => {
    for (const c of Object.values(CANON)) {
      expect(c.summary.length).toBeGreaterThan(10);
      expect(c.summary.length).toBeLessThan(120); // keep the index line cheap
    }
  });

  it('has a style category, so voice/mannerisms have somewhere to go', () => {
    expect(CANON.style).toBeDefined();
    expect(`${CANON.style.folder}/${CANON.style.title}`).toBe('Style/Voice');
  });
});
