import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const require = createRequire(import.meta.url);

// Runs a real PostgreSQL locally as a child process — no Docker, no manual
// install. Binaries are downloaded once on first init and cached in node_modules.
// The data lives in a folder next to the app (env.PG_DATA_DIR).

const serverRoot = path.resolve(fileURLToPath(import.meta.url), '../../..'); // packages/server
const dataDir = path.isAbsolute(env.PG_DATA_DIR) ? env.PG_DATA_DIR : path.resolve(serverRoot, env.PG_DATA_DIR);

let pg: EmbeddedPostgres | null = null;

function parseUrl(): { user: string; password: string; port: number; database: string } {
  const u = new URL(env.DATABASE_URL);
  return {
    user: decodeURIComponent(u.username) || 'cc',
    password: decodeURIComponent(u.password) || 'cc',
    port: Number(u.port) || 5432,
    database: u.pathname.replace(/^\//, '') || 'claude_control',
  };
}

/** Start the embedded Postgres and make sure the database exists. Idempotent. */
export async function startEmbeddedPostgres(): Promise<void> {
  if (!env.EMBEDDED_PG) return; // external Postgres — nothing to manage
  const { user, password, port, database } = parseUrl();

  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
    // Force a UTF-8 cluster (Windows initdb otherwise defaults to WIN1252,
    // which can't store emojis/arrows/other non-Latin1 text).
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    // Trim Postgres' memory footprint for a single-user desktop app. Stock
    // defaults reserve ~128MB shared_buffers + 100 connection slots + JIT +
    // several parallel/background workers — all wasted here. This cuts the
    // resident set by ~100MB with no practical impact at this scale.
    postgresFlags: [
      '-c', 'shared_buffers=32MB',
      '-c', 'max_connections=20',
      '-c', 'effective_cache_size=96MB',
      '-c', 'maintenance_work_mem=16MB',
      '-c', 'work_mem=4MB',
      '-c', 'wal_buffers=1MB',
      '-c', 'max_worker_processes=4',
      '-c', 'max_parallel_workers=2',
      '-c', 'max_parallel_workers_per_gather=1',
      '-c', 'autovacuum_max_workers=1',
      '-c', 'jit=off',
    ],
  });

  const firstRun = !existsSync(dataDir);
  if (firstRun) {
    logger.info('Initialising local database (first run downloads Postgres, ~1 min)…');
    await pg.initialise();
  }
  await pg.start();
  logger.info('Local Postgres ready', { port, dataDir });

  try {
    await pg.createDatabase(database);
    logger.info('Created database', { database });
  } catch {
    // Already exists — expected on subsequent runs.
  }
}

export async function stopEmbeddedPostgres(): Promise<void> {
  if (pg) {
    await pg.stop().catch(() => {});
    pg = null;
  }
}

// Locate the baseline schema SQL (works in dev and when packaged).
function migrationSqlPath(): string {
  const candidates = [
    path.resolve(serverRoot, 'prisma/migrations/0000_init/migration.sql'),
    path.resolve(serverRoot, '../server/prisma/migrations/0000_init/migration.sql'),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

/**
 * Ensure the schema exists. CLI-free (no Prisma CLI at runtime) so it works
 * under Electron and in a packaged app: connect with node-postgres, and if the
 * schema isn't there yet, run the baseline migration SQL.
 */
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<{ t: string | null }> }>;
  end(): Promise<void>;
}
export async function applySchema(): Promise<void> {
  const { Client } = require('pg') as {
    Client: new (config: { connectionString: string }) => PgClient;
  };
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT to_regclass('public.users') AS t");
    if (!rows[0]?.t) {
      logger.info('Applying database schema…');
      const sql = readFileSync(migrationSqlPath(), 'utf8');
      await client.query(sql);
      logger.info('Schema applied');
    }
    // Idempotent additive migrations for tables introduced after the baseline.
    // Runs on every boot (fresh + existing DBs) so upgrades don't need Prisma CLI.
    await client.query(ADDITIVE_SQL);
  } finally {
    await client.end();
  }
}

// Tables/columns added after the 0000_init baseline. Must be idempotent
// (CREATE TABLE/INDEX IF NOT EXISTS) so it's safe to run every startup.
const ADDITIVE_SQL = `
CREATE TABLE IF NOT EXISTS "workflows" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "graph" JSONB NOT NULL DEFAULT '{}',
  "createdBy" TEXT,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "workflows_serverId_idx" ON "workflows"("serverId");

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" TEXT PRIMARY KEY,
  "workflowId" TEXT NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "serverId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "log" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "tools" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "server_webhooks" ADD COLUMN IF NOT EXISTS "requireSignature" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "plans" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "agentId" TEXT,
  "channelId" TEXT,
  "dmThreadId" TEXT,
  "runId" TEXT,
  "goal" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "plans_serverId_idx" ON "plans"("serverId");

CREATE TABLE IF NOT EXISTS "plan_steps" (
  "id" TEXT PRIMARY KEY,
  "planId" TEXT NOT NULL REFERENCES "plans"("id") ON DELETE CASCADE,
  "order" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "agentName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "result" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "plan_steps_planId_idx" ON "plan_steps"("planId");

CREATE TABLE IF NOT EXISTS "agent_questions" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "agentId" TEXT NOT NULL,
  "channelId" TEXT,
  "dmThreadId" TEXT,
  "runId" TEXT,
  "prompt" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'open',
  "options" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "answer" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "agent_questions_serverId_idx" ON "agent_questions"("serverId");

CREATE TABLE IF NOT EXISTS "email_drafts" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "agentId" TEXT NOT NULL,
  "channelId" TEXT,
  "dmThreadId" TEXT,
  "runId" TEXT,
  "fromAddr" TEXT,
  "to" TEXT NOT NULL,
  "cc" TEXT,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "messageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "email_drafts_serverId_idx" ON "email_drafts"("serverId");

CREATE TABLE IF NOT EXISTS "vault_entries" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL,
  "valueEnc" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "label" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'custom',
  "auto" BOOLEAN NOT NULL DEFAULT false,
  "hits" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "vault_entries_serverId_fingerprint_key" ON "vault_entries"("serverId", "fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "vault_entries_serverId_token_key" ON "vault_entries"("serverId", "token");
CREATE INDEX IF NOT EXISTS "vault_entries_serverId_idx" ON "vault_entries"("serverId");

CREATE TABLE IF NOT EXISTS "resume_jobs" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "agentId" TEXT NOT NULL,
  "trigger" JSONB NOT NULL,
  "resumeAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "resume_jobs_status_resumeAt_idx" ON "resume_jobs"("status", "resumeAt");

CREATE TABLE IF NOT EXISTS "email_accounts" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL UNIQUE REFERENCES "servers"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "imapHost" TEXT NOT NULL,
  "imapPort" INTEGER NOT NULL DEFAULT 993,
  "smtpHost" TEXT NOT NULL,
  "smtpPort" INTEGER NOT NULL DEFAULT 465,
  "secure" BOOLEAN NOT NULL DEFAULT true,
  "passwordEnc" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "mcp_servers" (
  "id" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "command" TEXT,
  "args" JSONB NOT NULL DEFAULT '[]',
  "url" TEXT,
  "secretsEnc" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_serverId_name_key" ON "mcp_servers"("serverId", "name");

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboardedAt" TIMESTAMP(3);
ALTER TABLE "brain_notes" ADD COLUMN IF NOT EXISTS "embedding" BYTEA;
`;
