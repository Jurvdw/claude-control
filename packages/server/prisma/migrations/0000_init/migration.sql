-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "AgentModelClass" AS ENUM ('HAIKU', 'SONNET', 'OPUS');

-- CreateEnum
CREATE TYPE "AgentEffort" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('IDLE', 'THINKING', 'WORKING', 'ERROR', 'PAUSED');

-- CreateEnum
CREATE TYPE "SenderType" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('TEXT', 'FILE', 'CARD', 'AUDIO');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'REVIEW', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Anthropic',
    "ciphertext" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "valid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "iconUrl" TEXT,
    "ownerId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_members" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdById" TEXT NOT NULL,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#d97757',

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT NOT NULL,
    "bio" TEXT NOT NULL DEFAULT '',
    "statusText" TEXT NOT NULL DEFAULT '',
    "roleId" TEXT,
    "isManager" BOOLEAN NOT NULL DEFAULT false,
    "systemPrompt" TEXT NOT NULL,
    "modelClass" "AgentModelClass" NOT NULL DEFAULT 'SONNET',
    "effort" "AgentEffort" NOT NULL DEFAULT 'MEDIUM',
    "personality" INTEGER NOT NULL DEFAULT 30,
    "enabledTools" JSONB NOT NULL DEFAULT '[]',
    "memoryScope" TEXT NOT NULL DEFAULT 'both',
    "proactivity" JSONB NOT NULL DEFAULT '{}',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "status" "AgentStatus" NOT NULL DEFAULT 'IDLE',
    "thinkingLine" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "avatarUrl" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "modelClass" "AgentModelClass" NOT NULL DEFAULT 'SONNET',
    "effort" "AgentEffort" NOT NULL DEFAULT 'MEDIUM',
    "enabledTools" JSONB NOT NULL DEFAULT '[]',
    "isManager" BOOLEAN NOT NULL DEFAULT false,
    "roleColor" TEXT NOT NULL DEFAULT '#d97757',

    CONSTRAINT "agent_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "topic" TEXT NOT NULL DEFAULT '',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_threads" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT,
    "dmThreadId" TEXT,
    "senderType" "SenderType" NOT NULL,
    "userId" TEXT,
    "agentId" TEXT,
    "contentType" "ContentType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_notes" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "folder" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brain_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_proposals" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "noteId" TEXT,
    "folder" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "newContent" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brain_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "assignedAgentId" TEXT,
    "channelId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'managed',
    "result" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "agentId" TEXT,
    "channelId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hooks" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "agentId" TEXT NOT NULL,
    "channelId" TEXT,
    "promptTemplate" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_webhooks" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "messageId" TEXT,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "extractedText" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outputs" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "taskId" TEXT,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdByAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "agentId" TEXT,
    "trigger" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "taskId" TEXT,
    "channelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "agentId" TEXT,
    "runId" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL DEFAULT '',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE INDEX "servers_ownerId_idx" ON "servers"("ownerId");

-- CreateIndex
CREATE INDEX "server_members_userId_idx" ON "server_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "server_members_serverId_userId_key" ON "server_members"("serverId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "invites_code_key" ON "invites"("code");

-- CreateIndex
CREATE INDEX "invites_serverId_idx" ON "invites"("serverId");

-- CreateIndex
CREATE INDEX "roles_serverId_idx" ON "roles"("serverId");

-- CreateIndex
CREATE INDEX "agents_serverId_idx" ON "agents"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_templates_key_key" ON "agent_templates"("key");

-- CreateIndex
CREATE INDEX "channels_serverId_idx" ON "channels"("serverId");

-- CreateIndex
CREATE INDEX "dm_threads_serverId_userId_idx" ON "dm_threads"("serverId", "userId");

-- CreateIndex
CREATE INDEX "messages_serverId_idx" ON "messages"("serverId");

-- CreateIndex
CREATE INDEX "messages_channelId_createdAt_idx" ON "messages"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_dmThreadId_createdAt_idx" ON "messages"("dmThreadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "reactions_messageId_userId_kind_key" ON "reactions"("messageId", "userId", "kind");

-- CreateIndex
CREATE INDEX "brain_notes_serverId_folder_idx" ON "brain_notes"("serverId", "folder");

-- CreateIndex
CREATE INDEX "brain_proposals_serverId_status_idx" ON "brain_proposals"("serverId", "status");

-- CreateIndex
CREATE INDEX "memories_agentId_idx" ON "memories"("agentId");

-- CreateIndex
CREATE INDEX "tasks_serverId_status_idx" ON "tasks"("serverId", "status");

-- CreateIndex
CREATE INDEX "schedules_serverId_idx" ON "schedules"("serverId");

-- CreateIndex
CREATE INDEX "hooks_serverId_idx" ON "hooks"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "server_webhooks_secret_key" ON "server_webhooks"("secret");

-- CreateIndex
CREATE INDEX "server_webhooks_serverId_idx" ON "server_webhooks"("serverId");

-- CreateIndex
CREATE INDEX "files_serverId_idx" ON "files"("serverId");

-- CreateIndex
CREATE INDEX "outputs_serverId_taskId_idx" ON "outputs"("serverId", "taskId");

-- CreateIndex
CREATE INDEX "runs_serverId_createdAt_idx" ON "runs"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "runs_agentId_idx" ON "runs"("agentId");

-- CreateIndex
CREATE INDEX "approvals_serverId_status_idx" ON "approvals"("serverId", "status");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_dmThreadId_fkey" FOREIGN KEY ("dmThreadId") REFERENCES "dm_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_notes" ADD CONSTRAINT "brain_notes_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_proposals" ADD CONSTRAINT "brain_proposals_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "brain_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hooks" ADD CONSTRAINT "hooks_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hooks" ADD CONSTRAINT "hooks_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_webhooks" ADD CONSTRAINT "server_webhooks_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

