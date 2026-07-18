import { describe, it, expect } from 'vitest';
import {
  parseWikilinks,
  resolveLink,
  outgoingLinks,
  computeBacklinks,
  type NoteRef,
} from '../src/lib/wikilinks.js';

const notes: Array<NoteRef & { content: string }> = [
  { id: '1', folder: '', title: 'Ada', content: 'Works with [[Projects/Analytical Engine]] and [[Charles]].' },
  { id: '2', folder: 'Projects', title: 'Analytical Engine', content: 'Designed by [[Charles]].' },
  { id: '3', folder: '', title: 'Charles', content: 'No links here.' },
  { id: '4', folder: 'People', title: 'Ada', content: 'A different Ada. See [[Ada]] and [[Nowhere]].' },
];
const refs: NoteRef[] = notes.map(({ id, folder, title }) => ({ id, folder, title }));

describe('wikilink parsing', () => {
  it('parses plain, folder-qualified, and aliased links', () => {
    const links = parseWikilinks('[[Ada]] [[Projects/Analytical Engine]] [[Charles|the boss]]');
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({ title: 'Ada', folder: undefined });
    expect(links[1]).toMatchObject({ folder: 'Projects', title: 'Analytical Engine' });
    expect(links[2]).toMatchObject({ title: 'Charles', alias: 'the boss' });
  });

  it('ignores empty brackets', () => {
    expect(parseWikilinks('text [[]] more')).toHaveLength(0);
  });
});

describe('wikilink resolution', () => {
  it('resolves a folder-qualified link to the matching folder', () => {
    const [link] = parseWikilinks('[[Projects/Analytical Engine]]');
    expect(resolveLink(link, refs)?.id).toBe('2');
  });

  it('prefers the root note when a bare title is ambiguous', () => {
    const [link] = parseWikilinks('[[Ada]]');
    expect(resolveLink(link, refs)?.id).toBe('1'); // root Ada, not People/Ada
  });

  it('returns null for an unresolved link', () => {
    const [link] = parseWikilinks('[[Nowhere]]');
    expect(resolveLink(link, refs)).toBeNull();
  });
});

describe('graph edges', () => {
  it('lists outgoing links, marking unresolved ones', () => {
    const out = outgoingLinks(notes[3], refs); // People/Ada
    const nowhere = out.find((o) => o.link.target === 'Nowhere');
    expect(nowhere?.resolved).toBeNull();
    const ada = out.find((o) => o.link.target === 'Ada');
    expect(ada?.resolved?.id).toBe('1');
  });

  it('computes backlinks to a note', () => {
    const back = computeBacklinks(refs[2], notes); // Charles
    expect(back.map((n) => n.id).sort()).toEqual(['1', '2']);
  });

  it('drops self-links from outgoing edges', () => {
    const selfRef = { id: '5', folder: '', title: 'Loop', content: 'See [[Loop]].' };
    expect(outgoingLinks(selfRef, [{ id: '5', folder: '', title: 'Loop' }])).toHaveLength(0);
  });
});
