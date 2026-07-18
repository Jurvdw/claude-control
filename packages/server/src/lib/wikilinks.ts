// Obsidian-style [[wikilink]] parsing + resolution for the shared Brain.
//
// Supported forms:
//   [[Title]]                 → link to note by title
//   [[Folder/Title]]          → folder-qualified (disambiguates same-titled notes)
//   [[Title|display text]]    → aliased link (display text differs from target)

export interface WikiLink {
  raw: string; // the full "[[...]]" match
  target: string; // the note reference as written (may include "Folder/")
  folder?: string; // parsed folder prefix, if any
  title: string; // parsed title (target without the folder prefix)
  alias?: string; // display text after "|", if any
}

export interface NoteRef {
  id: string;
  folder: string;
  title: string;
}

// Global so we can iterate all matches; keep it stateless per call by re-creating.
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Split a target like "People/Ada" into { folder: "People", title: "Ada" }. */
function splitTarget(target: string): { folder?: string; title: string } {
  const t = target.trim();
  const slash = t.lastIndexOf('/');
  if (slash === -1) return { title: t };
  return { folder: t.slice(0, slash).trim(), title: t.slice(slash + 1).trim() };
}

/** Extract every wikilink from note content (order preserved, duplicates kept). */
export function parseWikilinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    if (!target) continue;
    const { folder, title } = splitTarget(target);
    links.push({ raw: m[0], target, folder, title, alias: m[2]?.trim() });
  }
  return links;
}

/** Resolve one link against the note set. Folder-qualified links must match the
 *  folder; bare links match by title (preferring a root-folder note on ties). */
export function resolveLink(link: WikiLink, notes: NoteRef[]): NoteRef | null {
  const wantTitle = norm(link.title);
  const candidates = notes.filter((n) => norm(n.title) === wantTitle);
  if (candidates.length === 0) return null;
  if (link.folder !== undefined) {
    const wantFolder = norm(link.folder);
    return candidates.find((n) => norm(n.folder) === wantFolder) ?? null;
  }
  if (candidates.length === 1) return candidates[0];
  return candidates.find((n) => !n.folder) ?? candidates[0];
}

/** Outgoing links from a note, each resolved to a note (or null if unresolved).
 *  Deduped by target, self-links dropped. */
export function outgoingLinks(
  note: NoteRef & { content: string },
  notes: NoteRef[],
): Array<{ link: WikiLink; resolved: NoteRef | null }> {
  const seen = new Set<string>();
  const out: Array<{ link: WikiLink; resolved: NoteRef | null }> = [];
  for (const link of parseWikilinks(note.content)) {
    const key = norm(link.target);
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = resolveLink(link, notes);
    if (resolved && resolved.id === note.id) continue; // ignore self-links
    out.push({ link, resolved });
  }
  return out;
}

/** Notes that link *to* the target (Obsidian "linked mentions"). */
export function computeBacklinks(
  target: NoteRef,
  notes: Array<NoteRef & { content: string }>,
): NoteRef[] {
  const refs = notes.filter((n) => n.title || n.folder).map((n) => ({ id: n.id, folder: n.folder, title: n.title }));
  const back: NoteRef[] = [];
  for (const n of notes) {
    if (n.id === target.id) continue;
    const hit = parseWikilinks(n.content).some((link) => resolveLink(link, refs)?.id === target.id);
    if (hit) back.push({ id: n.id, folder: n.folder, title: n.title });
  }
  return back;
}
