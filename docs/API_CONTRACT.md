# Claude Control — API & Realtime Contract (v1)

Authoritative contract that **both** the backend (Express) and frontend (React)
must implement. Author: Opus (architect). Do not deviate without updating this file.

Base URL: `API_URL` (default `http://localhost:4000`). All requests send cookies
(`credentials: 'include'`). Auth is a session cookie `cc_session` (httpOnly).
JSON everywhere. Errors: `{ "error": string }` with appropriate HTTP status.

Tenant rule: every route under `/servers/:serverId/...` MUST use the
`requireServerMember()` guard (returns 404 to non-members). Admin/Owner-only
mutations use `requireServerMember(MemberRole.ADMIN|OWNER)`.

## Auth
- `POST /auth/register` `{ email, password, displayName }` → `{ user }` + sets cookie
- `POST /auth/login` `{ email, password }` → `{ user }` + sets cookie
- `POST /auth/logout` → `{ ok: true }` clears cookie
- `GET  /auth/me` → `{ user }` or 401

## API keys (BYOK onboarding)
- `GET  /api-keys` → `{ keys: [{ id, label, last4, valid, createdAt }] }`
- `POST /api-keys` `{ label?, key }` → validates via a test call, encrypts, stores → `{ key, valid }`
- `DELETE /api-keys/:id` → `{ ok: true }`
- `GET  /provider/status` → `{ mode: 'apikey'|'subscription', selfHosted, hasKey }`

## Servers & membership
- `GET  /servers` → `{ servers: [{ id, name, description, iconUrl, role }] }` (user's memberships)
- `POST /servers` `{ name, description? }` → `{ server }` (creates default channel "general", a Manager agent optional, owner membership)
- `GET  /servers/:serverId` → `{ server, members: [{ userId, displayName, role }], settings }`
- `PATCH /servers/:serverId` (ADMIN) `{ name?, description?, settings? }` → `{ server }`
- `DELETE /servers/:serverId` (OWNER) → `{ ok: true }`
- `settings` shape: `{ brainWritePolicy: 'direct'|'propose', approvalMode: boolean, approvalActions: string[], hopLimit: number, maxConcurrent: number, proactiveDefault: boolean }`

## Invites
- `POST /servers/:serverId/invites` (ADMIN) `{ role?, maxUses?, expiresAt? }` → `{ invite: { code, ... } }`
- `GET  /invites/:code` → `{ server: { name }, valid }` (public preview)
- `POST /invites/:code/accept` (auth) → `{ server }` (adds membership)

## Channels
- `GET  /servers/:serverId/channels` → `{ channels: [{ id, name, topic, isDefault, position }] }`
- `POST /servers/:serverId/channels` (ADMIN) `{ name, topic? }` → `{ channel }`
- `PATCH /servers/:serverId/channels/:channelId` (ADMIN) `{ name?, topic? }` → `{ channel }`
- `DELETE /servers/:serverId/channels/:channelId` (ADMIN) → `{ ok }`

## Messages
- `GET  /servers/:serverId/channels/:channelId/messages?before?&limit=50` → `{ messages: Message[] }` (chronological asc)
- `POST /servers/:serverId/channels/:channelId/messages` `{ content, contentType? }` → `{ message }`
  - Side effect: parse `@mentions` / `@everyone`; enqueue agent runs (trigger `mention`) for matched agents in the server (hops=0).
- DMs: `GET /servers/:serverId/dms/:agentId/messages`, `POST /servers/:serverId/dms/:agentId/messages` `{ content }` (creates/uses a DmThread; enqueues trigger `dm`).
- `Message` shape: `{ id, serverId, channelId, dmThreadId, senderType: 'USER'|'AGENT'|'SYSTEM', userId, agentId, agentName?, contentType: 'TEXT'|'FILE'|'CARD', content, meta, createdAt, reactions: [{ userId, kind, feedback }] }`

## Reactions / feedback
- `POST /servers/:serverId/messages/:messageId/reactions` `{ kind: 'up'|'down', feedback? }` → `{ reaction }`
  - On `down` with feedback: store a correction note into the agent's private memory (create a Memory row keyed `correction:<timestamp>`), optionally the Brain.
- `DELETE /servers/:serverId/messages/:messageId/reactions/:kind` → `{ ok }`

## Agents
- `GET  /servers/:serverId/agents` → `{ agents: Agent[] }`
- `POST /servers/:serverId/agents` `{ name, avatarUrl?, bio?, statusText?, systemPrompt, modelClass?, effort?, personality?, enabledTools?, isManager?, roleColor?, requiresApproval?, proactivity? }` → `{ agent }`
- `GET  /servers/:serverId/agents/:agentId` → `{ agent }`
- `PATCH /servers/:serverId/agents/:agentId` `{ ...any of the above, enabled?, status?, modelClass?, effort? }` → `{ agent }`
- `DELETE /servers/:serverId/agents/:agentId` → `{ ok }`
- `POST /servers/:serverId/agents/:agentId/pause` / `/resume` → `{ agent }`
- `Agent` shape mirrors the Prisma model: `{ id, serverId, name, avatarUrl, bio, statusText, roleId, isManager, systemPrompt, modelClass: 'HAIKU'|'SONNET'|'OPUS', effort: 'LOW'|'MEDIUM'|'HIGH', personality (0-100), enabledTools: string[], memoryScope, proactivity, requiresApproval, status: 'IDLE'|'THINKING'|'WORKING'|'ERROR'|'PAUSED', thinkingLine, enabled }`
- `GET /agent-templates` → `{ templates: AgentTemplate[] }`
- `GET /tools` → `{ tools: [{ name, description, requiresApproval }] }`

## Brain
- `GET  /servers/:serverId/brain/notes` → `{ notes: [{ id, folder, title, summary, updatedAt }] }` (index — no content)
- `GET  /servers/:serverId/brain/notes/:noteId` → `{ note }` (full content)
- `POST /servers/:serverId/brain/notes` `{ folder?, title, summary?, content }` → `{ note }`
- `PATCH /servers/:serverId/brain/notes/:noteId` `{ folder?, title?, summary?, content? }` → `{ note }`
- `DELETE /servers/:serverId/brain/notes/:noteId` → `{ ok }`
- Proposals: `GET /servers/:serverId/brain/proposals?status=PENDING` → `{ proposals }`
- `POST /servers/:serverId/brain/proposals/:id/approve` → applies to note → `{ note }`
- `POST /servers/:serverId/brain/proposals/:id/reject` → `{ ok }`

## Tasks
- `GET  /servers/:serverId/tasks` → `{ tasks: Task[] }`
- `POST /servers/:serverId/tasks` `{ title, description?, assignedAgentId?, channelId?, mode? }` → `{ task }`
  - If `mode='managed'` (no assignee): enqueue the server's Manager agent (trigger `task`).
  - If `assignedAgentId`: enqueue that agent (trigger `task`).
- `PATCH /servers/:serverId/tasks/:taskId` `{ status?, result?, assignedAgentId? }` → `{ task }`
- `Task` shape: `{ id, title, description, status: 'QUEUED'|'IN_PROGRESS'|'REVIEW'|'DONE'|'FAILED', assignedAgentId, channelId, mode, result, createdAt }`

## Schedules (cron) & hooks
- `GET/POST/PATCH/DELETE /servers/:serverId/schedules` — `{ name, cron, prompt, agentId?, channelId?, enabled? }`
- `GET/POST/PATCH/DELETE /servers/:serverId/hooks` — `{ name, trigger: 'new_file'|'keyword'|'webhook', config, agentId, channelId?, promptTemplate, enabled? }`
- `GET /servers/:serverId/webhook` → `{ url }` (server's inbound webhook URL, created if missing)
- `POST /webhooks/:secret` (public) → fires matching webhook hooks → `{ ok }`

## Files & outputs
- `POST /servers/:serverId/files` (multipart `file`, optional `channelId`) → `{ file }` (extracts text for pdf/txt/md)
- `GET  /files/raw/:key` → binary (storage passthrough)
- `GET  /servers/:serverId/outputs?taskId?` → `{ outputs: [{ id, name, mimeType, size, url, taskId, createdAt }] }`

## Approvals
- `GET  /servers/:serverId/approvals?status=PENDING` → `{ approvals: [{ id, action, summary, payload, status, createdAt }] }`
- `POST /servers/:serverId/approvals/:id/approve` → executes the tool payload (getTool(action).execute) → `{ approval }`
- `POST /servers/:serverId/approvals/:id/reject` → `{ approval }`

## Usage
- `GET /servers/:serverId/usage?from&to` → `{
    totalCost, totalRuns,
    costOverTime: [{ date, cost }],
    perAgent: [{ agentId, agentName, cost, runs }],
    tokensByModel: [{ model, input, output }],
    topTasks: [{ taskId, title, cost }]
  }`
- `GET /usage` (across all the user's servers) → `{ perServer: [{ serverId, name, cost }], ... }`

## Notifications
- `GET  /notifications?unread?` → `{ notifications }`
- `POST /notifications/:id/read` → `{ ok }`
- `POST /notifications/read-all` → `{ ok }`

## Global controls
- `POST /servers/:serverId/pause-all` → pauses all agents in server → `{ ok }`
- `POST /servers/:serverId/resume-all` → `{ ok }`

---

# Socket.IO events

Client connects to `API_URL` with `withCredentials: true` (session cookie auth).
On connect the server authenticates via the cookie; unauthenticated → disconnect.

Client → server:
- `server:join` `{ serverId }` — join the server room (server verifies membership)
- `server:leave` `{ serverId }`
- `typing` `{ serverId, channelId }` (optional)

Server → client (emitted to the server room `server:<serverId>`):
- `agent:status` `{ serverId, agentId, status, thinkingLine }`
- `message:created` `{ serverId, channelId?, dmThreadId?, message }`
- `task:updated` `{ serverId, task }`
- `brain:updated` `{ serverId, note }`
- `proposal:created` `{ serverId, proposal }`
- `approval:created` `{ serverId, approval }`
- `approval:updated` `{ serverId, approval }`
- `run:parked` `{ serverId, agentId, resetAt?, runId? }`
- `run:resumed` `{ serverId, agentId }`

Server → client (emitted to the user room `user:<userId>`):
- `notification` `{ notification }`

These map 1:1 to the internal `bus` events in `src/realtime/bus.ts` (dot→colon
naming, e.g. `agent.status` → `agent:status`). The socket gateway subscribes to
`bus` and re-emits to the appropriate rooms.
