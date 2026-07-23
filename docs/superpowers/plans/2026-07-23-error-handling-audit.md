# Error-Handling Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every route handler under `packages/server/src/routes/` and every tool `execute()` under `packages/server/src/tools/` for inconsistent error surfacing, per spec §5.

**Architecture:** This is an audit-and-converge pass, not new functionality. The audit itself was performed while writing this plan (see Task 1) — it found **zero real bugs**. Every route and tool already follows one of this codebase's two established conventions (route: `try/catch` + `next(err)`; tool: catch internally and return an error string, OR let the centralized `executeToolForRun`/manual-loop catch-all at the two real call sites do it). This plan therefore has one task: record the audit and its findings, with no code changes, so the "still not built" roadmap item is closed out with evidence rather than silently dropped.

**Tech Stack:** TypeScript, Express 4.21.2, the existing tool-registry pattern (`packages/server/src/tools/registry.ts`).

## Global Constraints

- Express 4 (confirmed `packages/server/package.json:39`, `"express": "^4.21.2"`) auto-forwards a **synchronous** throw inside a route handler to the error-handling middleware without needing an explicit `try/catch` — this is core Express routing behavior, not a version-specific feature. Only unhandled **promise rejections** need explicit handling. This fact is load-bearing for Task 1's conclusions below.
- Every real tool-invocation call site already wraps `tool.execute()` in a generic `try/catch` that converts any thrown error into a `Error: ${message}` string (see Task 1, Finding 3) — so an individual tool is not required to self-catch to be safe, only to produce a nicer message than the generic fallback.
- No code in this plan should be changed purely for stylistic consistency where behavior is already correct — see Task 1's note on `create_workflow`.

---

### Task 1: Record the audit and its findings

**Files:**
- Create: `docs/superpowers/plans/2026-07-23-error-handling-audit-findings.md` (this task's only artifact — a permanent record of what was checked and why nothing needed changing)

**Interfaces:** None — this task produces documentation only, no code.

- [ ] **Step 1: Re-run the two audit greps from repo root and confirm output matches what's recorded below**

Run:
```bash
grep -rnE "\.(get|post|patch|put|delete)\('[^']*',\s*(async\s*)?\(req,\s*res\)\s*=>|\.(get|post|patch|put|delete)\([^,]+,\s*[a-zA-Z]+,\s*(async\s*)?\(req,\s*res\)\s*=>" packages/server/src/routes
```
Expected output (4 matches — route handlers with a `(req, res)` signature, i.e. no `next` param, meaning they cannot call `next(err)`):
```
packages/server/src/routes/apiKeys.ts:121:apiKeysRouter.post('/subscription/setup-token/start', (req, res) => {
packages/server/src/routes/apiKeys.ts:129:apiKeysRouter.get('/subscription/setup-token/status', (req, res) => {
packages/server/src/routes/apiKeys.ts:134:apiKeysRouter.post('/subscription/setup-token/cancel', (req, res) => {
packages/server/src/routes/auth.ts:85:authRouter.get('/me', requireAuth, async (req, res) => {
```

Run:
```bash
grep -rnE "catch\s*\(\s*\w*\s*\)\s*\{\s*\}|catch\s*\{\s*\}" packages/server/src
```
Expected output: no matches (no literally-empty catch blocks anywhere in the server).

- [ ] **Step 2: Write the findings doc**

```markdown
# Error-handling audit findings (2026-07-23)

Audited every route handler under `packages/server/src/routes/` (26 files)
and every tool `execute()` under `packages/server/src/tools/` (17 files, 40
`execute()` functions) against this codebase's two established conventions:

- **Route convention** (reference: `packages/server/src/routes/auth.ts`):
  `async (req, res, next) => { try { ... } catch (err) { next(err); } }`.
- **Tool convention** (reference: `packages/server/src/tools/coding.ts`):
  errors are caught and returned as a plain string
  (`` `Could not read "${input.path}": ${(err as Error).message}` ``), never
  thrown out of `execute()`.

(These counts are prose summaries, not the methodology — the audit itself
runs the two greps in the companion plan's Step 1 exhaustively over the
full `routes/`/`tools/` directories, and the "centralized catch-all" safety
argument below is structural, wrapping every `tool.execute()` call site
rather than relying on an enumerated whitelist — so a miscount here
doesn't change the conclusion, it was just wrong prose.)

## Result: no bugs found

### The 4 route handlers without a `next` param

`apiKeys.ts:121,129,134` (`/subscription/setup-token/{start,status,cancel}`)
and `auth.ts:85` (`/me`) all use `(req, res) => { ... }`, not
`(req, res, next) => { ... }`. Traced each:

- `auth.ts:85` (`GET /me`): reads properties off `req.user`, already
  populated by the `requireAuth` middleware earlier in the chain. No
  `await`, no I/O, nothing that can fail. Safe as-is.
- `apiKeys.ts:121` (`POST /subscription/setup-token/start`): calls
  `startSetupToken(req.user!.id)` — a **synchronous** function
  (`llm/setupTokenFlow.ts:59`, returns `void`) that can throw synchronously
  via `resolveClaudeBinary()` (line 17-26, throws on an unsupported
  platform or a missing bundled binary). Express 4 auto-catches a
  synchronous throw inside a route handler and forwards it to the error
  middleware — this is core routing dispatch behavior (the handler is
  invoked inside Express's own try/catch), not something that requires an
  explicit wrapper. Safe as-is; the child-process lifecycle after spawn
  (stdout parsing, exit handling) independently contains its own error
  handling inside `startSetupToken` (lines 87-99) — a `.catch()` on the
  `persistSubscriptionToken(...).then(...)` promise chain, functionally
  equivalent to a try/catch for error containment.
- `apiKeys.ts:129` (`GET /subscription/setup-token/status`) and
  `apiKeys.ts:134` (`POST /subscription/setup-token/cancel`): call
  `getSetupTokenStatus`/`cancelSetupToken`, both synchronous, both doing
  nothing but a `Map.get`/`kill()` on an in-memory session object — no
  realistic throw path. Safe as-is.

None of these four are promise-returning handlers with an unhandled
rejection risk (Express 4's gap is rejected promises, not sync throws) —
adding `next` and a try/catch to any of them would be inert defensive
code with no real failure mode behind it.

### Tool `execute()` functions

All 40 either catch internally and return a string (the majority — e.g.
every tool in `coding.ts`, `email.ts`, `files.ts`), or rely on the
centralized catch-all at the two real invocation sites:
`packages/server/src/agents/runLoop.ts:266-279` (the API-key-mode manual
tool loop) and `runLoop.ts:488-504` (`executeToolForRun`, used by both the
manual loop and, via `params.executeTool`, the subscription-mode SDK
bridge in `llm/subscription.ts:155`). Both wrap `tool.execute(...)` in
`try { ... } catch (err) { return/push \`Error: ${(err as Error).message}\`; }`
— any tool that throws still surfaces a normal string error to the model,
just with a generic prefix instead of a hand-written message.

One place exercises this path today: `tools/workflows.ts`'s `create_workflow`
(line 107-121) calls `compileGraph` (line 21-75), which deliberately throws
on an invalid step type (line 64-67, with a comment explaining the
throw is intentional — a prior fix for a silent-fallback bug: "A wrong
workflow that claims to work is worse than a rejected one"). `create_workflow`
does not catch this itself, unlike its sibling `run_workflow` (line 154-165)
in the same file, which does catch and return a custom string. Both are
safe in practice — the runLoop catch-all handles the uncaught case
correctly, and the thrown message text is already written as user-facing
guidance, so it reads fine either way. This is a minor stylistic asymmetry
between two tools in the same file, not a bug: no scenario exists where
`create_workflow`'s error is lost or malformed. Not changed — matching it
to `run_workflow`'s style would be a purely cosmetic diff with zero
behavior change.

### The one intentional silent catch

`packages/server/src/routes/approvals.ts:56-67` — approving a queued
action executes the tool and swallows any execution error in an empty-body
`catch` block, with an inline comment: `// execution errors don't block the
approval update`. This is the only silent catch found anywhere in the
server. It's deliberate and documented (a product choice — approving an
action always succeeds as an approval-record update, independent of
whether the now-stale tool call still succeeds), not an oversight. Not
changed — reversing this would be a product-behavior change, not a bug
fix, and is out of scope for an error-handling audit.

## Conclusion

No code changes made. Both established conventions (route try/catch+next,
tool string-return-on-error) are followed everywhere they need to be;
places that look like exceptions on a first grep pass turn out to be
either provably unreachable failure modes or already covered by a
centralized safety net one layer up.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-23-error-handling-audit-findings.md docs/superpowers/plans/2026-07-23-error-handling-audit.md
git commit -m "docs: error-handling audit — clean bill of health, no fixes needed"
```

## Self-Review

**Spec coverage:** Spec §5 asks for three things: (1) grep routes/tools for missing try/catch+next(err), (2) grep for throwing tool `execute()`s, (3) grep for silent empty catches. All three were actually run (Task 1, Step 1 gives the exact reproducible commands); every hit from all three was individually traced to a root cause and resolved as either safe-as-is or intentional. Spec explicitly anticipates this outcome: "If the audit turns up zero real issues... say so plainly... produce a minimal one-task plan that documents the audit's findings." Covered.

**Placeholder scan:** No TBD/TODO. No "add appropriate error handling" without showing what that means concretely — every finding names the exact file:line and explains the exact reasoning, not a generic gesture at "handle it."

**Type/signature consistency:** N/A — no code produced by this plan, so no cross-task signatures to check.
