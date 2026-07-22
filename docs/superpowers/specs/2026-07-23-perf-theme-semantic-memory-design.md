# Brain graph perf, message virtualization, light theme, semantic memory, error-handling audit — design

**Status:** approved, not yet implemented
**Owner:** Jur van der Welle

Five independent items pulled off the roadmap in one batch. They share no
code and can be built/reviewed/merged in any order — this doc covers all
five for efficiency, but each section stands alone. Self-eval/reflection was
considered and explicitly deferred (see [[improvement-roadmap]] memory) — no
concrete use case yet, and it roughly doubles run cost/latency per turn.

## 1. Brain graph performance

**Problem:** `BrainGraph.tsx`'s force-simulation repulsion pass (~line 121)
is a plain nested loop — every node pushes against every other node, once
per animation frame. O(n²). Fine today; would visibly stutter once a vault
crosses a few hundred notes.

**Approach:** a grid-based spatial hash, not a Barnes-Hut quadtree. Each
frame, bucket every node's current position into a grid of cells sized to
roughly the repulsion falloff radius; when computing repulsion for node A,
only visit nodes in A's cell and the 8 neighboring cells. Nodes farther away
contribute negligible force anyway (repulsion falls off as `1/d²`), so
skipping them is a legitimate approximation, not a correctness compromise.
This turns the common case (nodes roughly uniformly spread across the
canvas) into ~O(n) without the tree-construction/traversal complexity a real
Barnes-Hut implementation needs. Good enough through the low thousands of
nodes — well past any vault size this app will realistically see.

- Rebuild the grid fresh every frame (positions move every tick; no
  incremental maintenance needed at this scale).
- Cell size: tunable constant, start at ~1.5x the distance where repulsion
  becomes negligible given the existing `rep = 3200 / d2` formula.
- Edge attraction (the loop right after, over `edges`) is already O(edges),
  untouched.
- No change to the simulation's visual behavior/tuning constants — same
  forces, just computed over fewer pairs.

**Testing:** a unit test isolating the spatial-hash bucketing function
(given N positions, does it return the same neighbor-candidate set a naive
O(n²) scan would, for a few hand-constructed layouts) — the physics loop
itself stays manually/visually verified like the rest of `BrainGraph.tsx`.

## 2. Message virtualization

**Problem:** `MessageFeed.tsx` renders every message in the current slice
via a plain `.map()` inside one `overflow-y-auto` div, capped at
`MAX_RENDERED = 200` — a stopgap, not real virtualization. A 200-message
channel mounts 200 DOM subtrees (including image/card/attachment content)
at once.

**Approach:** `react-virtuoso`, not `react-window`. Message heights vary
substantially (plain text, code blocks, cards, images, attachments), and
Virtuoso measures actual rendered height per item rather than requiring a
fixed/estimated size up front — react-window's variable-size list needs
that estimate maintained by hand, which is exactly the kind of thing that
silently drifts as message content types are added later. Virtuoso also has
first-class support for the "pinned to bottom, new messages append, older
history loads on scroll-up" pattern this feed needs.

- Replace the `.map()` render with `<Virtuoso>` (or `<VirtuosoMessageList>`
  if its chat-specific ergonomics fit better once evaluated in-repo),
  keeping the existing per-message JSX (avatar, bubble, attachments,
  reactions, mention highlighting) as the item renderer unchanged.
- Drop `MAX_RENDERED` — windowing makes the render-count cap unnecessary.
  Keep whatever the existing message-fetch pagination limit is (server-side
  history loading is a separate, already-solved concern).
- Preserve current behavior: auto-scroll to bottom on new own-message send,
  stay pinned to bottom on new incoming messages only if already at bottom
  (don't yank the view if the user has scrolled up to read history).

**Testing:** existing e2e coverage (`sends a message and shows it in the
channel`, `loads existing messages...`, `survives a socket reconnect...`)
already exercises the feed end-to-end and will catch a broken swap; add one
more e2e case sending enough messages to force multiple virtualization
windows and asserting the newest is visible.

## 3. Light theme

**Problem:** colors are hardcoded — Tailwind's `ink`/`cream`/`clay` palette
is literal hex in `tailwind.config.js`, `index.css` hardcodes
`color-scheme: dark` plus a literal dark body background/text color, and 28
component files reference `ink-*`/`cream-*`/`clay-*` classes directly. No
`darkMode` strategy is configured at all.

**Approach:** CSS custom properties, not a `dark:` variant rewrite.
Rewriting 28 files to add `dark:` prefixes to every color class (and adding
light equivalents) is a large, error-prone diff that touches nearly the
whole component tree for a purely cosmetic change. Instead:

- Redefine each Tailwind color (`ink-900`, `cream-50`, `clay-500`, etc.) to
  resolve through a CSS variable (`var(--ink-900)`, ...) instead of a
  literal hex, in `tailwind.config.js`.
- Define two variable sets in `index.css`: `:root` (dark, today's existing
  hex values, unchanged) and `:root[data-theme="light"]` (a light palette —
  cream tones take the background/surface roles, ink tones take the
  text/foreground roles, clay accent unchanged across both). Every existing
  `bg-ink-900`/`text-cream-100`/etc. class keeps working, unmodified, in
  every one of the 28 files — only the resolved value changes.
- `color-scheme` on `:root` also needs to flip with the same attribute
  (`light dark` → set explicitly per theme) so native form controls/
  scrollbars match.
- A small theme controller (new `useTheme` hook or context): reads a stored
  preference from `localStorage` (`cc.theme`: `'system' | 'light' | 'dark'`,
  default `'system'`), resolves `'system'` via
  `matchMedia('(prefers-color-scheme: light)')` (and subscribes to its
  `change` event so a live OS theme switch is picked up without reload),
  and sets `data-theme` on `<html>` accordingly.
- Settings gains a new **Appearance** section: a three-way System/Light/Dark
  selector wired to the hook.

**Testing:** one e2e test — set Light via the selector, assert `data-theme`
on `<html>` and a spot-checked computed background color; reload, assert the
preference persisted. Exact palette values get eyeballed in-browser during
implementation (a design doc can't pre-verify contrast/vibe), not
pre-specified hex-by-hex here.

## 4. Semantic memory

**Problem:** Brain recall is keyword/substring-index only (per the compact
title+summary index shipped in every agent's system prompt) — no way to
find a relevant note by meaning when it doesn't share vocabulary with the
query.

**Approach, and what it deliberately is not:** no vector database. The
bundled `embedded-postgres` binary (v18.4.0-beta.17) does not ship the
`pgvector` extension, and standing up one would mean either compiling it
into the bundled binary (real build/packaging work, per-platform) or adding
an external vector store — both disproportionate to the vault sizes this
app actually has (low hundreds of notes per workspace, typically). Instead:

- New dependency: `@xenova/transformers`, model `Xenova/all-MiniLM-L6-v2`
  (384-dim sentence embeddings, ONNX runtime, CPU inference, no GPU
  requirement). Runs fully in the Node process — no API key, no per-call
  network request, no new credential type. Honest caveat to flag to the
  user in the Settings copy: the ~90MB model weights download once from
  Hugging Face's CDN on first use, then cache locally — "local" means no
  per-call API, not zero network ever.
- Schema: `BrainNote` gains `embedding Bytes?` (ADDITIVE_SQL, nullable —
  existing notes start with no embedding). Stored as a packed
  `Float32Array` buffer (384 × 4 bytes), not JSON — avoids per-query
  float-parsing overhead and keeps row size predictable.
- Compute on write: wherever a `BrainNote` is created or its
  `title`/`summary`/`content` changes (capture tools, manual edits,
  proposal approval), embed `title + summary + content` and store the
  result. Fire-and-forget relative to the write itself if embedding
  generation is slow enough to matter (measure during implementation) —
  the note is fully usable via keyword search in the meantime.
- Retrieval: brute-force cosine similarity across a workspace's notes'
  embeddings, computed in Node at query time. Trivial cost at expected vault
  scale (a few hundred 384-float dot products is sub-millisecond); no index
  structure needed.
- Surfaced as a **new, additive capability**, not a replacement for existing
  keyword search — e.g. a `search_brain_semantic` tool (or a `mode` param on
  the existing brain search tool, exact shape decided during
  implementation) an agent can call alongside the existing index-based
  recall. Nothing about current keyword-search behavior changes.
- Notes with `embedding: null` (created before this shipped, or if
  generation failed) are simply excluded from semantic results, not
  backfilled automatically — a backfill script is easy to add later if
  wanted but isn't needed for this to work going forward.

**Testing:** unit tests for the cosine-similarity ranking function (given
known vectors, does it return the expected order) and for the
Bytes↔Float32Array pack/unpack round-trip. The embedding model itself
(quality of what it returns for real text) is not something to unit-test —
same category as "is the LLM's output good," verified by trying it, not
asserted in CI.

## 5. Error-handling audit

**Problem:** no systematic check that failures across newer routes/tools
surface consistently. Not a design question — an audit-and-fix pass.

**Approach:** grep every file under `packages/server/src/routes/` and
`packages/server/src/tools/` for:
- Route handlers missing a `try/catch` + `next(err)` (the established
  pattern, per `routes/auth.ts` and others already in the codebase).
- Tool `execute()` functions that can throw instead of returning a
  string error (the established tool convention — errors are returned to
  the model as text, not thrown, per every existing tool in
  `tools/coding.ts`/`tools/email.ts`/etc.).
- Any place swallowing an error silently (empty `catch {}`) where the
  caller has no way to know the operation failed.

Bring every finding into line with whichever of those two established
conventions applies (route vs. tool). Not a redesign of error handling —
convergence on the patterns already established elsewhere in this
codebase.

**Testing:** no new tests specifically for this — existing route/tool tests
continue to cover behavior; the audit's job is consistency, not new
functionality.

## Explicitly out of scope (all five items)

- Agent self-eval/reflection — deferred, see above.
- Any change to `run_code`, the sandboxed JS tool — untouched by the
  semantic-memory or coding-agent work.
- A vector database or external embeddings API — rejected in §4 for this
  app's scale and local-first posture.
- Rewriting component files for a `dark:` Tailwind strategy — rejected in
  §3 in favor of CSS variables.
- Backfilling embeddings for pre-existing Brain notes — not needed for the
  feature to work going forward; can be a follow-up script if wanted.
- Publishing an auto-update release — a separate operational action
  (`GH_TOKEN=… npm run release`), not a design/code item, handled
  separately with its own explicit go-ahead.
