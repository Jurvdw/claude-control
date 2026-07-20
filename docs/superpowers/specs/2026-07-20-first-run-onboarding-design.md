# First-run onboarding — design

**Status:** approved, not yet implemented
**Owner:** Jur van der Welle

## Problem

Today's first-run path is: register → connect Claude (already decent, but the
subscription tab tells the user to leave the app and run two terminal
commands) → land in an empty `#general` with a Manager the user doesn't know
exists → figure the rest out alone. There is no walkthrough of Brain,
Workflows, or any other core feature, and nothing tells a new user that agents
only respond to `@mention` — so a first plain message gets silence, which reads
as broken.

This spec covers the whole first-run journey: register → connect Claude →
workspace creation → guided tour → real app.

## 1. End-to-end flow

```
Register → Connect Claude (revised) → workspace auto-created → spotlight tour (7 stops) → real app
```

Runs once per user. Never shown again after completion or skip.

## 2. Connect Claude — no terminal required

Current state: the subscription tab's copy says `npm i -g @anthropic-ai/claude-code`
then `claude setup-token` in an external terminal, then paste the printed token.
That first line is already false — the app bundles the real `claude` CLI binary
(`claude.exe`, shipped inside `@anthropic-ai/claude-agent-sdk-win32-x64` for the
Agent SDK) which has a working `setup-token` subcommand. Verified directly:
`claude.exe --help` lists it, `claude.exe setup-token --help` confirms no
required flags.

New flow:

- A single **"Connect with Claude subscription"** button. The server spawns the
  bundled `claude.exe setup-token` as a child process. This opens the user's
  default browser to Anthropic's sign-in page — unavoidable for OAuth, but a
  browser tab, not a terminal.
- UI shows a "Waiting for you to sign in…" state with a cancel button while the
  child process runs.
- On success, `setup-token` prints the token to stdout. The server captures it,
  parses it out, and saves it through the existing credential-save path (same
  as a pasted token today). UI advances automatically — no copy-paste.
- On failure (browser closed without finishing, timeout, spawn error), show a
  clear error and fall back to today's manual-paste field, kept as a collapsed
  "or paste a token manually" option for edge cases (no default browser,
  headless/corporate environments).
- API key tab and ambient-login detection (`claudeLoginDetected` /
  `connectExistingLogin`) are unchanged — already zero-friction.

## 3. Workspace: auto-created

Today, workspace creation is a manual "New workspace" modal (name input, Enter
to submit) reached through the workspace switcher. For first-run this step is
removed: the moment Claude is connected, a default workspace is created
automatically (name editable later in settings), seeded with the Manager agent
exactly as workspace creation does today (`servers.ts` already seeds the
`isManager: true` `AgentTemplate` into every new workspace — this is existing
behavior, not new). Manual workspace creation stays available, unchanged, for
anyone adding a second workspace later.

## 4. The tour: 7 spotlight stops

Mechanism: dimmed backdrop, cutout + tooltip anchored to the real, live UI
element, `Next` / `Skip` on every card. The tour is **view-aware**: if a step's
target panel isn't the currently active view, the tour switches `view` state
itself before rendering the highlight — it does not wait for the user to
navigate there manually.

1. **Welcome** — "This is #general. Your Manager is already here and ready to
   work."
2. **Chat** — "Agents only respond when @mentioned — that's how you talk to
   any of them, including your Manager." Composer is prefilled with
   `@Manager ` so the mention is already there; the user just adds the rest.
   Advances automatically if they send a message; `Next` works regardless
   (never blocks on a required action).
3. **Brain** — shared long-term memory across agents: notes plus the privacy
   vault.
4. **Tasks** — how agents track and hand off work.
5. **Workflows** — automation: trigger → steps → agent action. Points at the
   existing templates (Daily digest, Research → Brain, Watch a URL, Scheduled
   report, Webhook → agent, Delayed follow-up).
6. **Triggers** — how workflows fire on a schedule or webhook, not just on
   demand. Own card, conceptually paired with Workflows.
7. **Closing** — "That's the core loop. Settings has your account, privacy
   vault, and usage — explore anytime." → Dismiss.

Deliberately excluded from the tour: Activity and Usage panels get one mention
in the closing line, not their own stop. A full stop for all 8 app views would
be a slog, not a tour — YAGNI applies to tour length same as to code.

## 5. Persistence

New field: `User.onboardedAt DateTime?`. Set the moment the tour is dismissed
or skipped. One-time only — no relaunch entry point (decided: "one time is
fine"). If it needs to become re-triggerable later, that's a separate,
easy follow-up (a "Take the tour again" link in Settings reading the same
flag), not built now.

## 6. Error handling

- `setup-token` spawn failure, timeout, or the user closing the browser without
  completing sign-in → clear error message, falls back to manual token paste
  (same failure path as today's flow, so no new failure mode for the user to
  learn).
- Tour step targeting a panel that isn't mounted/active → the tour switches
  `view` itself first (see §4), so this is not a user-facing error case at all.
- Workspace auto-creation failing is out of scope here — it reuses the existing
  workspace-creation code path and its existing error handling.

## 7. Testing

- e2e (Playwright): extend the existing fixtures (`signUp` → workspace flow)
  with a pass through all 7 tour steps, asserting `onboardedAt` is set after
  completion/skip, and that a reload does not replay the tour.
- The `setup-token` capture flow is impractical to fully automate (real OAuth
  sign-in). Unit-test the stdout-parsing and state-machine logic (starting →
  waiting-for-browser → success/error) against a fake/mocked child process.
  Leave the live OAuth round-trip as a manually-tested path, same as the
  existing manual-paste flow is today.

## Explicitly out of scope

- Relaunching/replaying the tour after first completion.
- Tour stops for Activity, Usage, MCP servers, or Settings sub-panels — closing
  card only.
- Any change to the API-key connect path or ambient-login detection — both
  already frictionless.
- Any change to how agents are triggered (`@mention`-only stays as-is) — the
  tour teaches the existing behavior, it doesn't change it.
