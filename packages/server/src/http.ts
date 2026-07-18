import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { attachUser } from './auth/middleware.js';
import { TenantError } from './auth/guards.js';
import { logger } from './lib/logger.js';

// Routes
import { authRouter } from './routes/auth.js';
import { apiKeysRouter, providerRouter } from './routes/apiKeys.js';
import { serversRouter } from './routes/servers.js';
import { invitesRouter, publicInvitesRouter } from './routes/invites.js';
import { channelsRouter } from './routes/channels.js';
import { messagesRouter } from './routes/messages.js';
import { reactionsRouter } from './routes/reactions.js';
import { agentsRouter, agentTemplatesRouter, toolsRouter } from './routes/agents.js';
import { brainRouter } from './routes/brain.js';
import { tasksRouter } from './routes/tasks.js';
import { schedulesRouter } from './routes/schedules.js';
import { workflowsRouter } from './routes/workflows.js';
import { plansRouter } from './routes/plans.js';
import { questionsRouter } from './routes/questions.js';
import { emailDraftsRouter } from './routes/emailDrafts.js';
import { emailRouter } from './routes/email.js';
import { mcpRouter } from './routes/mcp.js';
import { searchRouter } from './routes/search.js';
import { activityRouter } from './routes/activity.js';
import { workspaceRouter } from './routes/workspace.js';
import { hooksRouter, webhookReceiverRouter } from './routes/hooks.js';
import { filesRouter, filesRawRouter } from './routes/files.js';
import { approvalsRouter } from './routes/approvals.js';
import { usageRouter, globalUsageRouter } from './routes/usage.js';
import { notificationsRouter } from './routes/notifications.js';

export function createApp() {
  const app = express();

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use(cors({ origin: env.APP_URL, credentials: true }));
  app.use(cookieParser());
  // Stash the raw body so webhook HMAC signatures can be verified byte-for-byte.
  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; },
  }));
  app.use(attachUser);

  // ── Auth ───────────────────────────────────────────────────────────────────
  app.use('/auth', authRouter);

  // ── API keys & provider ────────────────────────────────────────────────────
  app.use('/api-keys', apiKeysRouter);
  app.use('/provider', providerRouter);

  // ── Servers & top-level membership ─────────────────────────────────────────
  app.use('/servers', serversRouter);

  // ── Invites (nested under servers + public) ─────────────────────────────────
  app.use('/servers', invitesRouter);    // POST /servers/:serverId/invites
  app.use('/invites', publicInvitesRouter); // GET /invites/:code, POST /invites/:code/accept

  // ── Channels ──────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/channels', channelsRouter);

  // ── Messages (channel + DM) ────────────────────────────────────────────────
  // Channel messages: /servers/:serverId/channels/:channelId/messages
  // DM messages:      /servers/:serverId/dms/:agentId/messages
  app.use('/servers/:serverId/channels', messagesRouter);
  app.use('/servers/:serverId', messagesRouter);

  // ── Reactions ─────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/messages/:messageId/reactions', reactionsRouter);

  // ── Agents ────────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/agents', agentsRouter);
  app.use('/agent-templates', agentTemplatesRouter);
  app.use('/tools', toolsRouter);

  // ── Brain ──────────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/brain', brainRouter);

  // ── Tasks ──────────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/tasks', tasksRouter);

  // ── Schedules ──────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/schedules', schedulesRouter);

  // ── Workflows (n8n-style automations) ────────────────────────────────────────
  app.use('/servers/:serverId/workflows', workflowsRouter);

  // ── Plans (Manager plan-then-execute) ────────────────────────────────────────
  app.use('/servers/:serverId/plans', plansRouter);

  // ── Agent questions (interactive question cards) ─────────────────────────────
  app.use('/servers/:serverId/questions', questionsRouter);

  // ── Email drafts (preview / edit / revise / send cards) ──────────────────────
  app.use('/servers/:serverId/email-drafts', emailDraftsRouter);

  // ── Email (IMAP/SMTP integration) ────────────────────────────────────────────
  app.use('/servers/:serverId/email', emailRouter);

  // ── MCP servers (mount external MCP servers as agent tools) ──────────────────
  app.use('/servers/:serverId/mcp', mcpRouter);

  // ── Search ─────────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/search', searchRouter);

  // ── Activity (agent run timeline) ────────────────────────────────────────────
  app.use('/servers/:serverId/activity', activityRouter);

  // ── Workspace export / import (backup & restore) ─────────────────────────────
  app.use('/servers/:serverId', workspaceRouter);

  // ── Hooks + webhook URL ────────────────────────────────────────────────────
  // Specific webhook URL route must come before generic hooks
  app.use('/servers/:serverId', hooksRouter);     // /webhook (under server scope)
  app.use('/servers/:serverId/hooks', hooksRouter);
  app.use('/webhooks', webhookReceiverRouter);    // public

  // ── Files & outputs ────────────────────────────────────────────────────────
  app.use('/servers/:serverId', filesRouter);      // /files and /outputs
  app.use('/files/raw', filesRawRouter);

  // ── Approvals ──────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/approvals', approvalsRouter);

  // ── Usage ──────────────────────────────────────────────────────────────────
  app.use('/servers/:serverId/usage', usageRouter);
  app.use('/usage', globalUsageRouter);

  // ── Notifications ──────────────────────────────────────────────────────────
  app.use('/notifications', notificationsRouter);

  // ── Static SPA ──────────────────────────────────────────────────────────────
  // Serve the built web app on the same port whenever it exists (the local app
  // runs as a single process). In dev the Vite server on :5173 proxies here.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, '../../web/dist'); // packages/web/dist
  if (existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  // ── Error handler ───────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof TenantError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('unhandled error', { error: (err as Error).message ?? String(err) });
    return res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
