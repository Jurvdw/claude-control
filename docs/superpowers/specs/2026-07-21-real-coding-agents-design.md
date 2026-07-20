# Real coding agents — design

**Status:** approved, not yet implemented
**Owner:** Jur van der Welle

## Problem

Claude Control already has a "Coder" agent template, but its only tool
(`run_code`) evaluates short JavaScript snippets in a `node:vm` sandbox with
no filesystem or network access — it can't read, write, or run anything real.
There is no way today to point an agent at an actual project on disk and have
it work the way Claude Code does: reading and editing real files, running
real shell commands, using git.

The app already bundles the exact SDK that powers real Claude Code
(`@anthropic-ai/claude-agent-sdk`), and already strips its built-in
Read/Write/Edit/Bash/Glob/Grep tools out of every request (`subscription.ts`)
purely to save the ~14k tokens/call they cost when unused. Turning real
coding capability on is mostly a wiring problem, not a from-scratch build —
for subscription-mode agents. API-key-mode agents run through a separate,
hand-built tool loop with no such built-ins, so they need genuinely new
tools written from scratch to reach parity.

## 1. Scope

- Both execution modes get real coding capability: Claude subscription
  (SDK built-ins, translated) and bring-your-own API key (new custom tools).
- One project folder per **workspace** (`Server`), shared by every
  coding-capable agent in that workspace — not per-agent, not picked
  ad hoc in chat.
- No per-action approval. Once a workspace has a project folder and an
  agent has a coding tool enabled, that tool runs the moment the model
  calls it — the same trust model as running Claude Code yourself in that
  folder. This is a deliberate choice, not an oversight (see §5).

## 2. The six tools

Exposed through the **existing** per-agent tool checkbox grid
(`AgentCreateModal.tsx`), alongside `web_search`, `send_email`, etc. — no new
UI surface, no schema change to `Agent`/`AgentTemplate`. An agent opts into
any subset:

| Tool | Kind |
|---|---|
| `read_file` | read-only |
| `list_dir` | read-only |
| `search_code` | read-only (grep-style) |
| `write_file` | mutating |
| `edit_file` | mutating |
| `run_bash` | shell, cwd = the workspace's project folder |

Deliberately excluded: the SDK's `Task` tool (spawns nested sub-sessions,
which would collide with this app's own multi-agent/mention model) and
`TodoWrite` (redundant with the app's existing Task/Plan system). This app's
built-in `run_code` (sandboxed JS eval) is untouched and stays available —
it's a different, narrower tool, not superseded.

## 3. Project directory

A new **workspace-level** setting, `Server.settings.projectDir` — sits inside
the existing `settings Json` blob (`Server` has no dedicated columns for
per-workspace config; everything lives there today), so this needs no
Prisma schema change and reuses the existing shallow-merge `PATCH
/servers/:serverId` endpoint.

Set via a native OS folder picker: Electron's
`dialog.showOpenDialog({ properties: ['openDirectory'] })`, exposed through
the same preload/IPC pattern already used for update-checking
(`window.ccDesktop.*`) — a new `pickFolder()` method. Settings UI shows the
current path (or "not set") with a "Choose folder…" button.

**Fence check**, applied server-side whenever `projectDir` is set (in the
`PATCH /servers/:serverId` handler): reused from
`packages/server/src/lib/mcpFence.ts`'s `protectedRoots()` and `contains()`
primitives (currently private to that file — export them). A candidate
`projectDir` is rejected with a clear error if it resolves inside, or is an
ancestor of, any protected root: the server's own src/dist directory, the
repo/resources root, the Electron install directory, or the app's
`%APPDATA%\Claude Control` data directory. This is the same check that
already stops an MCP filesystem server from being pointed at the app's own
codebase, applied to the same class of setting.

## 4. Subscription mode wiring

In `packages/server/src/llm/subscription.ts`, at the point the SDK request
options are built (currently `tools: wantsWebSearch ? ['WebSearch'] : []`):

- If the workspace has no `projectDir` set, none of the six are translated
  at all — the built-in tool schemas are never added to `tools`, matching
  this file's existing philosophy of not shipping unused tool schemas
  (they cost real tokens per request whether or not they're ever called).
  The agent simply doesn't have coding tools yet; no error surfaces mid-run.
- If `projectDir` is set: for each of the six canonical names the agent has
  enabled, add the matching SDK built-in to the `tools` array:
  `read_file`→`Read`, `list_dir`→`Glob`, `search_code`→`Grep`,
  `write_file`→`Write`, `edit_file`→`Edit`, `run_bash`→`Bash`. Also set
  `cwd: projectDir` on the SDK options.
- Extend `canUseTool` (currently a strict allowlist of `mcp__*` +
  `WebSearch`) with a branch permitting exactly the built-ins the agent has
  enabled, returning `{ behavior: 'allow', updatedInput: toolInput }` with no
  approval step.

## 5. API-key mode wiring

Six new tools in `packages/server/src/tools/` (new file, e.g.
`coding.ts`), registered via the existing `registerTool()` pattern
(`registry.ts`), matching `tools/files.ts`'s structural precedent (uses
`ctx` to resolve context) rather than `run_code`'s sandboxed-and-isolated
one. Each tool's `execute(input, ctx)`:

1. Looks up the workspace's `projectDir` via `ctx.serverId` → `Server.settings`.
2. If unset, returns a clear error string (`"No project folder set for this
   workspace — set one in workspace settings before using coding tools."`)
   rather than throwing — same graceful-degradation shape the rest of this
   codebase uses for unconfigured integrations (e.g. email).
3. Resolves the tool's path argument(s) against `projectDir` and performs
   the real operation: `node:fs/promises` for
   read/write/edit/list/search, `node:child_process` (`spawn`, no shell
   string interpolation) for `run_bash`, with `cwd: projectDir`.
4. None of the six set `requiresApproval` — consistent with §1's autonomy
   decision, and a deliberate contrast with `run_code` (which does require
   approval, being a different, more experimental tool with different
   defaults).

## 6. Coder template update

`packages/server/src/db/seed.ts`'s `coder` template's `enabledTools` changes
from `[...DEFAULT_TOOLS, ...DOC_TOOLS, 'run_code']` to
`[...DEFAULT_TOOLS, 'read_file', 'list_dir', 'search_code', 'write_file',
'edit_file', 'run_bash']` — applies to newly-created workspaces only.
Existing agents in existing workspaces keep whatever `enabledTools` they
already have; nothing is retroactively changed. Anyone can opt any agent
into any subset of the six tools via the existing checkbox UI regardless of
template.

## 7. Safety, stated plainly

Two different things are true at once, and both matter:

- **The fence protects the app itself.** A workspace's project folder can
  never be set to Claude Control's own install, source, or data directory —
  so an agent can't be accidentally (or deliberately) pointed at modifying
  the app that's running it.
- **The fence does not sandbox what happens inside the folder.** Once
  `run_bash` is enabled, it is real, unrestricted shell access with `cwd`
  set to the project folder — nothing stops a command from using `../` or an
  absolute path to reach outside it, exactly as nothing stops you from doing
  the same in a real terminal opened in that folder. This is the direct
  consequence of choosing no per-action approval: the trust boundary is
  "did you enable this tool for this agent and point it at a real folder,"
  not "was this specific command reviewed."

## 8. Error handling

- No `projectDir` set, tool enabled anyway → the two modes degrade
  differently, both without a broken mid-run tool call: API-key mode's
  tools are registered regardless of `projectDir` (the checkbox UI doesn't
  know about workspace settings) and return the clear in-chat error from §5
  point 2 when actually called; subscription mode never adds the built-in
  schemas to `tools` in the first place (§4), so the model simply doesn't
  see those tools as available and can't attempt to call them.
- `projectDir` fails the fence check at set-time → the `PATCH` request
  itself is rejected with a 400 and a specific message naming which
  protected root it collided with; the setting is never persisted.
- `projectDir` later becomes invalid (folder deleted/moved after being set)
  → individual tool calls fail naturally (ENOENT etc.) and the error string
  is returned to the model to react to, same as any other tool failure in
  this codebase — no special-cased recovery.

## 9. Testing

- Unit tests for the new fence check (`checkProjectDir` or equivalent),
  mirroring `mcpFence.test.ts`'s existing cases.
- Unit tests for the six API-key-mode tools with mocked `node:fs`/
  `node:child_process`, following this repo's established
  pure-function-with-mocked-deps convention — no route-level tests, per
  this codebase's standing test style.
- Subscription-mode wiring (the `tools` array + `canUseTool` translation)
  gets logic-level unit tests where feasible (e.g. "agent with `run_bash`
  enabled produces a `tools` array containing `Bash`"); the live SDK
  round-trip (an agent actually editing a real file) is manually verified,
  matching how `run_code`/`send_email`/the setup-token OAuth flow were each
  verified in this codebase — not automatable without a real project
  directory and a real SDK session.

## Explicitly out of scope

- Per-action approval for any of the six tools — a possible future toggle,
  not built now.
- Multiple project folders per agent, or per-agent folder overrides —
  one folder per workspace only.
- Any change to the existing sandboxed `run_code` tool.
- Git-specific tooling beyond what `run_bash` already provides — `git` is
  just a shell command an agent can already run once `run_bash` is enabled.
- The SDK's `Task` and `TodoWrite` built-ins.
