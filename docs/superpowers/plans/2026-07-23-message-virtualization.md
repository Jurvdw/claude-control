# Message Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `MessageFeed.tsx`'s flat `.map()` over up to 200 messages with `react-virtuoso` windowed rendering, so long channels only mount the DOM subtrees for messages actually near the viewport.

**Architecture:** Swap the render loop only. `MessageItem` (the existing per-message component — avatar, markdown body, attachments, reactions, mention highlighting) is reused unchanged as Virtuoso's `itemContent` renderer. `<Virtuoso>` owns scroll position and "stay pinned to bottom on new messages, unless the user has scrolled up" behavior via its `followOutput` prop, replacing the current unconditional `scrollIntoView` effect. The `MAX_RENDERED = 200` render cap is removed entirely — windowing makes it unnecessary.

**Tech Stack:** React 18, `react-virtuoso` (new dependency), TypeScript, Tailwind. `packages/web` has no unit test runner (only `tsc --noEmit` via `npm run lint`) — verification for this plan is TypeScript compilation + the real Playwright e2e suite (`packages/desktop/e2e/`), which is this codebase's established way of testing web UI behavior changes.

## Global Constraints

- `packages/web` has no unit test runner configured (no vitest/jest in `package.json`) — do not add one for this plan. Verify with `npm run lint -w @cc/web` (TypeScript) and the e2e suite (`npm run e2e -w claude-control` from repo root).
- Match the codebase's existing code style in `MessageFeed.tsx`: Tailwind utility classes (no CSS modules/styled-components), no comments except where a non-obvious constraint needs explaining (this file already follows that convention — keep it).
- The e2e suite must stay isolated per `packages/desktop/e2e/fixtures.ts` (temp `--user-data-dir`, ports 4000/54329 must be free — the fixture refuses to run otherwise). Never run it while the real Claude Control app is open.
- `packages/desktop/release/win-unpacked/Claude Control.exe` must exist and reflect current code before running e2e (`npm run dist` at repo root rebuilds it if stale — only needed if a test fails in a way that suggests stale dist, per the existing e2e fixture's own comments).

---

### Task 1: Add the `react-virtuoso` dependency

**Files:**
- Modify: `packages/web/package.json`

**Interfaces:**
- Produces: `react-virtuoso` importable from `packages/web/src/**` as `import { Virtuoso } from 'react-virtuoso'`.

- [ ] **Step 1: Install the dependency**

Run: `npm install react-virtuoso -w @cc/web`

Expected: `packages/web/package.json`'s `dependencies` gains a `"react-virtuoso"` entry, and the root `package-lock.json` updates. No other package's dependencies change.

- [ ] **Step 2: Verify the workspace still type-checks and builds**

Run: `npm run lint -w @cc/web`
Expected: exits 0, no output (this package's `lint` script is `tsc --noEmit`).

Run: `npm run build -w @cc/web`
Expected: exits 0, `packages/web/dist/` is produced.

- [ ] **Step 3: Commit**

```bash
git add packages/web/package.json package-lock.json
git commit -m "Add react-virtuoso dependency for message list virtualization"
```

---

### Task 2: Virtualize `MessageFeed`'s render loop

**Files:**
- Modify: `packages/web/src/components/MessageFeed.tsx`

**Interfaces:**
- Consumes: `useServer()` from `../state/ServerContext` — unchanged shape: `{ messages: Message[]; activeChannel: Channel | null; loadingMessages: boolean; agents: Agent[] }`. `messages` is already deduped/ordered oldest→newest by `ServerContext` (new messages are appended via the `message:created` socket handler; nothing in this task changes that).
- Consumes: `MessageItem` — the existing internal component in this same file (lines 109–224 of the current version), unchanged. Its props stay exactly `{ m: Message; agentColor?: string; isManager?: boolean; mentionHandles: Set<string> }`.
- Produces: no exported interface changes — `MessageFeed` is still the default export, still takes no props, still reads everything from `useServer()`.

This task replaces lines 72–107 of the current file (the `MessageFeed` function body) and makes one small addition to `MessageItem`'s outer `<div>` className. Nothing else in the file (imports below `Attachment`, `MAX_RENDERED` removal, `MENTION_RE`/`highlightMentions`, `MessageItem`'s internals from line 132 down to 224) changes except the two spots called out below.

- [ ] **Step 1: Remove the `MAX_RENDERED` cap**

In `packages/web/src/components/MessageFeed.tsx`, delete these lines (the constant and its comment, currently just above `MENTION_RE`):

```tsx
// Cap rendered messages so very long channels stay light (older ones stay in
// state and can still be scrolled once loaded, but we don't paint them all).
const MAX_RENDERED = 200;
```

- [ ] **Step 2: Add the `react-virtuoso` import**

At the top of the file, alongside the other imports:

```tsx
import { Virtuoso } from 'react-virtuoso';
```

- [ ] **Step 3: Replace the `MessageFeed` function body**

Replace the entire current `export default function MessageFeed() { ... }` block with:

```tsx
export default function MessageFeed() {
  const { messages, activeChannel, loadingMessages, agents } = useServer();
  const mentionHandles = new Set(agents.map((a) => a.name.replace(/\s+/g, '').toLowerCase()));

  if (!activeChannel) {
    return <div className="flex-1 flex items-center justify-center text-ink-500">Pick a channel to start.</div>;
  }

  if (!loadingMessages && messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center text-ink-500">
        <div className="text-4xl mb-3">💬</div>
        <p className="text-cream-300 font-medium">This is the start of #{activeChannel.name}.</p>
        <p className="text-sm mt-1">Say hi, or @mention an agent to put them to work.</p>
      </div>
    );
  }

  return (
    // min-h-0 is required here: this div's parent is a flex column, and a
    // flex child's default min-height is `auto` (its content size), not 0 —
    // without this override, Virtuoso's height:100% child collapses the
    // whole feed to zero height instead of filling the available space.
    <div className="flex-1 min-h-0">
      {loadingMessages && <div className="text-center text-ink-500 text-sm py-4">Loading…</div>}
      <Virtuoso
        data={messages}
        computeItemKey={(_index, m) => m.id}
        // Start scrolled to the newest message, not the top of the list.
        initialTopMostItemIndex={messages.length - 1}
        // Only auto-follow new messages if the user is already at (or near)
        // the bottom — don't yank the view if they've scrolled up to read
        // history. Virtuoso calls this on every data change.
        followOutput={(isAtBottom) => (isAtBottom ? 'smooth' : false)}
        style={{ height: '100%' }}
        // Padding is applied on Virtuoso's own scroller element (via the
        // custom Scroller component below), not a div wrapping Virtuoso —
        // that way it scrolls WITH the content, matching the original
        // layout's px-6 py-4 on the scrollable element itself. Padding on an
        // outer wrapper instead would sit outside the scroll area, so the
        // first/last message would land flush against the viewport edge.
        components={{ Scroller: ScrollerWithPadding }}
        itemContent={(_index, m) => {
          const agent = agents.find((a) => a.id === m.agentId);
          return <MessageItem m={m} agentColor={agent?.roleColor} isManager={agent?.isManager} mentionHandles={mentionHandles} />;
        }}
      />
    </div>
  );
}

// Virtuoso's own scroller needs the horizontal/vertical padding the old
// plain-div layout had (px-6 py-4) — applying it via a wrapping div instead
// would put padding outside the scrollable area, so top/bottom messages
// would sit flush against the viewport edge once scrolled.
const ScrollerWithPadding = forwardRef<HTMLDivElement, React.HTMLProps<HTMLDivElement>>(function ScrollerWithPadding(props, ref) {
  return <div {...props} ref={ref} className="px-6 py-4" />;
});
```

- [ ] **Step 4: Fix the React import line**

`forwardRef` is newly needed (for `ScrollerWithPadding`); `useEffect` and `useRef` are no longer used anywhere in this file — Virtuoso's `followOutput` fully replaces the old `bottomRef` + `scrollIntoView` effect, and nothing else in the file used either hook. Change the top-of-file import from:

```tsx
import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
```

to:

```tsx
import { Children, forwardRef, useState, type ReactNode } from 'react';
```

- [ ] **Step 5: Preserve inter-message spacing on `MessageItem`'s outer div**

The old layout had `gap-1` on the flex column wrapping all messages; Virtuoso's items aren't flex siblings, so that gap needs to move onto each item. In `MessageItem` (still the same function, untouched otherwise), change its outer `<div>`'s className from:

```tsx
<div className="group flex gap-3 px-2 py-1.5 rounded-lg hover:bg-ink-800/50 transition-colors animate-fade-in">
```

to:

```tsx
<div className="group flex gap-3 px-2 py-1.5 mb-1 rounded-lg hover:bg-ink-800/50 transition-colors animate-fade-in">
```

- [ ] **Step 6: Type-check**

Run: `npm run lint -w @cc/web`
Expected: exits 0, no output.

- [ ] **Step 7: Build**

Run: `npm run build -w @cc/web`
Expected: exits 0, `packages/web/dist/` regenerated.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/MessageFeed.tsx
git commit -m "Virtualize MessageFeed with react-virtuoso, drop the 200-message render cap"
```

---

### Task 3: e2e regression coverage for virtualized rendering

**Files:**
- Modify: `packages/desktop/e2e/app.spec.ts`

**Interfaces:**
- Consumes: `signUp`, `createWorkspace`, `test`, `expect` from `./fixtures` (already imported at the top of this file) — no changes to those helpers.
- Consumes: `POST /servers/:serverId/channels/:channelId/messages` with JSON body `{ content: string }` (200, returns `{ message: Message }`) — the same endpoint the UI's own "Send" button calls, confirmed at `packages/server/src/routes/messages.ts:73`.

This adds one new `test()` inside the existing `test.describe('Claude Control desktop', ...)` block, after the last existing test (`fires a webhook-triggered workflow and posts the result`). No existing test in this file needs to change — Virtuoso still renders real DOM nodes with the same text content for on-screen messages, so selectors like `page.getByRole('paragraph').filter({ hasText: ... })` keep working unmodified.

- [ ] **Step 1: Add the test**

Append inside the `test.describe(...)` block, after the final existing test's closing `});`:

```ts
  test('virtualizes a long message list and stays pinned to the newest message', async ({ page }) => {
    // Regression for the react-virtuoso swap (2026-07-23): confirms the feed
    // still renders the newest message and stays scrolled to it after a
    // volume of messages that would previously all mount as DOM nodes at
    // once (and, pre-virtualization, would have been silently truncated by
    // the old MAX_RENDERED=200 cap — this volume is deliberately below 200
    // so a regression back to the old cap would NOT be caught by messages
    // going missing, only by a real virtualization check).
    await signUp(page);
    await createWorkspace(page);

    const { serverId, channelId } = await page.evaluate(async () => {
      const { servers } = await fetch('/servers', { credentials: 'include' }).then((r) => r.json());
      const serverId = servers[0].id;
      const { channels } = await fetch(`/servers/${serverId}/channels`, { credentials: 'include' }).then((r) => r.json());
      return { serverId, channelId: channels[0].id };
    });

    // Seed 60 messages directly via the API — fast and deterministic versus
    // typing+sending 60 times through the UI, and exercises the same
    // endpoint the Send button uses.
    const lastMarker = 'virtuoso e2e message 60';
    await page.evaluate(
      async ({ serverId, channelId, lastMarker }) => {
        for (let i = 1; i <= 60; i++) {
          const content = i === 60 ? lastMarker : `virtuoso e2e message ${i}`;
          const res = await fetch(`/servers/${serverId}/channels/${channelId}/messages`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
          });
          if (!res.ok) throw new Error(`message ${i} POST failed: ${res.status}`);
        }
      },
      { serverId, channelId, lastMarker },
    );

    await page.reload();
    await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 60_000 });

    // The newest message must be visible without any manual scrolling —
    // proves initialTopMostItemIndex/followOutput land the view at the
    // bottom of a freshly loaded long list.
    await expect(page.getByRole('paragraph').filter({ hasText: lastMarker })).toBeVisible({ timeout: 15_000 });

    // The first seeded message must NOT be mounted — proves the list is
    // actually windowed, not just capped-then-fully-rendered.
    await expect(page.getByRole('paragraph').filter({ hasText: 'virtuoso e2e message 1' })).toHaveCount(0);
  });
```

- [ ] **Step 2: Run the full e2e suite**

Run: `npm run e2e -w claude-control` (from repo root; ports 4000/54329 must be free — close the real app first if it's running)

Expected: all tests pass, including the new one — `13 passed (N.Nm)` (12 pre-existing plus this one; note the exact pre-existing count may drift if other work has landed first, but every test including the new one must show `ok`, none `failed`).

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/e2e/app.spec.ts
git commit -m "Add e2e regression test for virtualized message rendering"
```

---

## Manual verification (in addition to e2e)

The e2e test proves the mechanism works on a fresh reload; it does not exercise live-scrolling feel or the socket-driven append path. Before considering this plan fully done, manually check in the real running app:
1. Open a channel with many messages, scroll up to read history, then have another message arrive (e.g. from another browser tab/session) — the view must NOT jump back to bottom.
2. Send a message yourself while scrolled to the bottom — the view must smoothly follow it.
3. Scroll through a long channel — no visible flicker/jank as items mount/unmount off the top and bottom edges.
