# Claude Control

Claude Control is a Discord-style AI control center for building and orchestrating Claude-powered agents. Teams can create specialized AI agents that collaborate via channels, tasks, and shared knowledge (Brain), with full tenant isolation and cost tracking.

## Stack

- **Backend**: Node.js + Express + Prisma ORM + PostgreSQL
- **Database**: **embedded PostgreSQL** — started automatically as a local child process. **No Docker, no install, no separate server.** (Data lives in `packages/server/data/pg`.)
- **Frontend**: React + Socket.IO (real-time updates)
- **Desktop**: Electron shell → packaged to a native `.exe` (installer + portable) via electron-builder
- **Jobs**: in-process runner (concurrency-limited) + cron scheduler — no Redis/queue server
- **Auth**: Session-based (httpOnly cookies) with role-based access (OWNER, ADMIN, MEMBER)
- **LLM**: Dual-mode provider: BYOK (Anthropic API key) or self-hosted subscription

## Desktop app (a real `.exe`, no Docker)

Claude Control ships as a native **Electron desktop app** — its own window, not a browser tab. The app boots an embedded PostgreSQL (a local child process), applies the schema, seeds starter agents, and serves the UI, all self-contained. No Docker, no database install.

### Run the desktop app

```bash
npm install         # first time only
npm run desktop     # builds the UI + server, launches the native app window
```

On Windows you can also just double-click **`Claude Control.cmd`** (installs + builds on first run, then opens the app).

First launch initializes a local database (~1 minute). Your data lives in your user profile (`%AppData%/Claude Control`), not the repo. Close the window to stop everything (Postgres shuts down cleanly).

### Build a distributable `.exe`

```bash
npm run dist        # produces packages/desktop/release/
```

Outputs (Windows):
- **`Claude Control Setup <version>.exe`** — installer (Start-menu shortcut, choose install dir)
- **`Claude Control <version>.exe`** — single-file portable app (no install)

The packaged app is fully standalone — it bundles Electron, the backend, the embedded Postgres binary, and the UI, so it runs on a machine with **no Node.js, no Postgres, no Docker**. (macOS/Linux targets are configured too; run `npm run dist` on that OS.)

> Packaging notes: the build stages a self-contained copy of the backend with its production dependencies (`packages/desktop/scripts/stage.mjs`), then `electron-builder` packs it. Code-signing is off by default (`signAndEditExecutable: false`); add a certificate in `packages/desktop/package.json` → `build` to sign.

## Run in the browser instead (optional)

Prefer a browser tab / headless server? The same backend runs standalone:

```bash
npm run app         # embedded Postgres + server + built UI on http://localhost:4000
```

Dev mode with hot reload:

```bash
npm run dev         # server on :4000 (embedded PG), Vite web on :5173 (proxied)
```

Prerequisite for all of the above: **Node.js 20+** only.

## Running on a Claude subscription (instead of pay-per-token)

The desktop app can run your agents on your **Claude Pro / Max / Team / Enterprise** subscription via the Claude Agent SDK — usage draws from your plan's limits instead of pay-per-token API billing.

### Setup

1. Install Claude Code: `npm i -g @anthropic-ai/claude-code`
2. Generate a token: `claude setup-token` (sign in with your Claude account; it prints a token).
3. In the app's onboarding, choose **"Claude subscription"** and paste the token.

Under the hood the token is stored encrypted and passed to the Agent SDK as `CLAUDE_CODE_OAUTH_TOKEN`; the SDK owns the agent loop and calls our tools as in-process MCP tools. The SDK's binary is bundled, so nothing else is required.

### ⚠️ Important caveat

Subscription mode is **gated to the self-hosted desktop app** (`SELF_HOSTED=true`, which the packaged app sets automatically) and is for **individual use of your own subscription, on your own machine, only**. Anthropic does **not** permit third-party products to offer claude.ai login or to pool/proxy/resell subscription access — so this must never be exposed as a hosted multi-user service. Anthropic's policy here has changed before and this mode may stop working.

### BYOK (Anthropic API key)

The default and the only option for hosted/browser use: paste an Anthropic API key (from console.anthropic.com). It's encrypted at rest (AES-256-GCM), validated before storing, and billed pay-per-token to your account.

The provider is chosen per-account by which credential you connect (subscription wins when present and self-hosted). See [docs/API_CONTRACT.md](docs/API_CONTRACT.md) for `/provider/status` and `/api-keys`.

## License & using this with Claude

Licensed under the **[Apache License 2.0](LICENSE)** — free to use, modify, and
distribute, commercially or not, with a patent grant.

That license covers **this source code only**. It grants you nothing with
respect to Anthropic's services: that's a separate relationship between you and
Anthropic, and a license from us cannot widen it. Bring your own credentials and
follow their terms.

**Read [NOTICE](NOTICE) before deploying.** Apache 2.0 §4(d) requires that file
to travel with any copy you distribute, and it spells out what actually matters:

- **Subscription mode is single-user, self-hosted only.** Anthropic's Consumer
  Terms forbid sharing account credentials or making your account available to
  others — so never expose it as a hosted or multi-user service, and never pool,
  proxy, or resell subscription access. `SELF_HOSTED=true` gates this in code;
  don't strip the gate to work around the rule. **Multi-user means BYOK**, where
  each user brings their own API key.
- **The Usage Policy covers whatever your agents do**, and you're responsible
  for directing them.
- **Tell people they're talking to AI.** The UI labels agents; if you wire one
  to email, chat, or a public endpoint, keep that disclosure.

Not affiliated with or endorsed by Anthropic. "Claude" is their trademark, used
here only to describe interoperability.

## VPS / single-node deployment

The app is self-contained — it needs only Node.js. The embedded Postgres works on a server too, so a minimal deploy is:

```bash
# 1. Set secrets (put these in packages/server/.env or the environment)
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

# 2. Build + run behind a reverse proxy (Caddy/Nginx) that terminates HTTPS and
#    proxies to http://localhost:4000
npm install
npm run app        # embedded Postgres + server + built web on :4000
```

Run it under a process manager (systemd, pm2) so it restarts on reboot. Point `APP_URL`/`API_URL` at your domain.

**Prefer a managed/external Postgres in production?** Set `EMBEDDED_PG=false` and point `DATABASE_URL` at your instance, then `npm run build && npm start`. Everything else is unchanged.

## Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | development | Set to `production` for VPS |
| `PORT` | 4000 | Backend port |
| `DATABASE_URL` | embedded (`…@127.0.0.1:54329/claude_control`) | Postgres connection string; defaults to the embedded instance |
| `EMBEDDED_PG` | true | Start a local Postgres child process. Set `false` to use an external Postgres via `DATABASE_URL` |
| `PG_DATA_DIR` | ./data/pg | Where the embedded Postgres stores data (relative to `packages/server`) |
| `ENCRYPTION_KEY` | (dev fallback) | 32-byte key in base64. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `SESSION_SECRET` | dev-session-secret-change-me | Random string for session signing |
| `LLM_PROVIDER_MODE` | apikey | `apikey` (BYOK) or `subscription` (self-hosted) |
| `SELF_HOSTED` | false | Only used if `LLM_PROVIDER_MODE=subscription` |
| `ANTHROPIC_API_KEY` | (optional) | Fallback key for server-initiated agent runs (subscription mode) |
| `APP_URL` | http://localhost:5173 | Frontend public URL |
| `API_URL` | http://localhost:4000 | Backend public URL (for CORS) |
| `STORAGE_DRIVER` | local | `local` (disk) or `s3` (S3-compatible) |

## Architecture

### Monorepo Layout

```
claude-control/
├── packages/server/          # Node.js backend
│   ├── src/
│   │   ├── index.ts          # Express entry
│   │   ├── auth/             # Auth guards & session middleware
│   │   ├── llm/              # Model pricing, cost estimation
│   │   ├── tools/            # Tool registry (Brain, messaging, code, etc.)
│   │   ├── routes/           # REST API endpoints
│   │   ├── agents/           # Run loop, context assembly, dispatch
│   │   ├── queue/            # In-process runner + cron scheduler
│   │   ├── db/               # Embedded Postgres + seed
│   │   └── realtime/         # Socket.IO gateway + event bus
│   ├── prisma/
│   │   ├── schema.prisma     # Data model (all tenant-scoped)
│   │   └── seed.ts           # Seed 6 starter agent templates
│   └── tests/                # Vitest unit tests
├── packages/desktop/         # Electron shell → packaged .exe (electron-builder)
│   ├── electron/main.cjs     # boots the backend as a child, renders the window
│   └── scripts/stage.mjs     # stages a self-contained backend for packaging
├── packages/web/             # React frontend
│   ├── src/
│   │   ├── pages/            # Page routes
│   │   ├── components/       # Reusable UI
│   │   └── hooks/            # React hooks (API calls, Socket.IO)
│   └── vite.config.ts        # Vite bundler config
└── docs/
    └── API_CONTRACT.md       # Authoritative REST & Socket.IO schema
```

### Tenant Isolation

Every `Server` is owned by a user. All database queries include a `serverId` filter. The auth layer enforces this via:

```typescript
// Any route accessing a server MUST check membership
app.get('/servers/:serverId/agents', requireServerMember(), (req, res) => {
  // req.membership is { serverId, role }
  // Non-members get 404 (not 403) to prevent server enumeration
});
```

For background jobs (agent runs, webhooks), use `assertServerAccess(userId, serverId)` to verify tenant isolation before executing tools.

### Token-Efficient Brain

The `BrainNote` model stores team knowledge with a `summary` field (one-liner). When injecting the Brain into agent context, only summaries are included in the system prompt, keeping token usage low. Full notes are read on-demand via the `read_brain_note` tool.

## Testing

```bash
# Run all tests (Vitest)
npm run test

# Watch mode
npm run test:watch
```

Tests include:
- `crypto.test.ts` — encrypt/decrypt round-trips, tampering detection
- `pricing.test.ts` — model pricing, cost estimation math
- `guards.test.ts` — role hierarchy (OWNER ≥ ADMIN ≥ MEMBER)
- `tenant-isolation.test.ts` — multi-user isolation invariant (requires live Postgres)

## API Reference

For a complete REST and Socket.IO contract, see [docs/API_CONTRACT.md](docs/API_CONTRACT.md). Key endpoints:

- **Auth**: `/auth/{register,login,logout,me}`
- **Servers**: `GET/POST /servers`, `GET/PATCH/DELETE /servers/:serverId`
- **Agents**: `GET/POST/PATCH /servers/:serverId/agents`
- **Messages & Channels**: `/servers/:serverId/channels/:channelId/messages`
- **Brain**: `/servers/:serverId/brain/{notes,proposals}`
- **Tasks**: `GET/POST/PATCH /servers/:serverId/tasks`
- **Usage**: `GET /servers/:serverId/usage` (cost breakdown by agent & model)

All authenticated endpoints use the `cc_session` cookie; no bearer tokens.

## Contributing

- Type-check: `npm run lint`
- Format: Prettier (integrated in the repo)
- Commit directly to the current branch (see `.claude/CLAUDE.md`)

## License

Private — Informatica internal project.
