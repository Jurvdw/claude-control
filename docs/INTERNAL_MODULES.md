# Internal module map (already built — import, do not reinvent)

All paths under `packages/server/src/`. ESM + NodeNext: **import with `.js`
extensions** (e.g. `import { prisma } from '../lib/prisma.js'`).

## Config & infra
- `config/env.js` → `env` (typed), `subscriptionModeEnabled`, `isProd`
- `lib/prisma.js` → `prisma` (PrismaClient singleton)
- `lib/crypto.js` → `encrypt(s)`, `decrypt(s)`, `randomToken(bytes?)`
- `lib/redis.js` → `redisConnection` (ioredis, `maxRetriesPerRequest: null` — pass to BullMQ)
- `lib/logger.js` → `logger.{debug,info,warn,error}(msg, meta?)`
- `lib/storage.js` → `storage.{ put(buffer,{ext,contentType}), get(key), url(key) }`

## Auth
- `auth/password.js` → `hashPassword(p)`, `verifyPassword(hash,p)`
- `auth/session.js` → `SESSION_COOKIE`, `createSession(userId)`, `getSessionUser(sid)`, `destroySession(sid)`, `setSessionCookie(res,sid)`, `clearSessionCookie(res)`
- `auth/middleware.js` → `attachUser` (populates `req.user`, non-rejecting), `requireAuth`
- `auth/guards.js` → `requireServerMember(min?: MemberRole)`, `assertServerAccess(userId,serverId,min?)`, `getMembership(userId,serverId)`, `roleAtLeast(role,min)`, `TenantError`
  - `req.membership = { serverId, role }` is set by `requireServerMember`.
- `MemberRole` enum from `@prisma/client`: `OWNER|ADMIN|MEMBER`.

## LLM
- `llm/index.js` → `getProviderForUser(userId)`, `validateKey(apiKey)`, `estimateCost(model,usage)`, `MODEL_IDS`, `EFFORT_MAP`, `PRICES`, error classes `LLMRateLimitError`, `LLMAuthError`, types.

## Tools
- `tools/index.js` → registers all tools; exports `getTool(name)`, `allTools()`, `toolSpecsFor(names)`, `DEFAULT_TOOLS`, `ALL_TOOL_NAMES`, `type ToolContext`, `type Tool`.
- A tool: `{ name, description, input_schema, requiresApproval?, summarize?, execute(input, ctx) }`.
- `ToolContext = { serverId, agent, ownerUserId, channelId?, dmThreadId?, taskId?, runId? }`.

## Agents / run loop
- `agents/runLoop.js` → `runAgent(trigger)` (the worker calls this), `setResumer(fn)`.
- `agents/dispatch.js` → `enqueueAgentRun(trigger)`, `setDispatcher(fn)`, `type AgentTrigger`, `type TriggerKind`.
  - `AgentTrigger = { serverId, agentId, trigger: TriggerKind, channelId?, dmThreadId?, taskId?, prompt?, hops?, triggeredByMessageId? }`
  - `TriggerKind = 'mention'|'dm'|'task'|'schedule'|'hook'|'agent'|'manual'`
- `agents/context.js` → `assembleContext(agent, server, trigger)` (used internally by runAgent).

## Realtime bus
- `realtime/bus.js` → `bus.emit(event, payload)`, `bus.on(event, handler)`, `type BusEvents`.
  Events (payloads in bus.ts): `agent.status`, `message.created`, `task.updated`,
  `brain.updated`, `proposal.created`, `approval.created`, `approval.updated`,
  `run.parked`, `run.resumed`, `notification`.

## Wiring responsibilities (backend agent)
1. `src/queue/*`: create BullMQ queue `agent-runs` + worker → `runAgent(job.data)`.
   Register `setDispatcher((t) => queue.add('run', t))` and
   `setResumer((t, delayMs) => queue.add('run', t, { delay: delayMs }))`.
   Add a `schedules` queue with repeatable jobs from the Schedule table.
2. `src/realtime/socket.js`: Socket.IO server; auth via `cc_session` cookie
   (`getSessionUser`); `server:join`/`leave` (verify membership via `getMembership`);
   subscribe to `bus` and re-emit to rooms `server:<id>` / `user:<id>` per the
   API contract naming (dot→colon).
3. `src/http.js`: express app (cors with credentials + APP_URL origin, cookie-parser,
   express.json, `attachUser`, mount routers, serve `packages/web/dist` in prod,
   JSON error handler that maps `TenantError`).
4. `src/index.js`: create http server from app, attach io, register dispatcher +
   resumer, start workers, `listen(env.PORT)`.
