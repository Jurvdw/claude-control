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
