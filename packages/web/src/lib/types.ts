export type SenderType = 'USER' | 'AGENT' | 'SYSTEM';
export type ContentType = 'TEXT' | 'FILE' | 'CARD';
export type AgentStatus = 'IDLE' | 'THINKING' | 'WORKING' | 'ERROR' | 'PAUSED';
export type ModelClass = 'HAIKU' | 'SONNET' | 'OPUS';
export type Effort = 'LOW' | 'MEDIUM' | 'HIGH';
export type TaskStatus = 'QUEUED' | 'IN_PROGRESS' | 'REVIEW' | 'DONE' | 'FAILED';
export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type BrainWritePolicy = 'direct' | 'propose';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  onboardedAt: string | null;
}

export interface ServerSettings {
  brainWritePolicy: BrainWritePolicy;
  approvalMode: boolean;
  approvalActions: string[];
  hopLimit: number;
  maxConcurrent: number;
  proactiveDefault: boolean;
}

export interface Server {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  role: MemberRole;
  settings?: ServerSettings;
}

export interface ServerMember {
  userId: string;
  displayName: string;
  role: MemberRole;
}

export interface Channel {
  id: string;
  name: string;
  topic?: string;
  isDefault: boolean;
  position: number;
}

export interface Reaction {
  userId: string;
  kind: 'up' | 'down';
  feedback?: string;
}

export interface MessageFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface Message {
  id: string;
  serverId: string;
  channelId?: string;
  dmThreadId?: string;
  senderType: SenderType;
  userId?: string;
  agentId?: string;
  agentName?: string;
  contentType: ContentType;
  content: string;
  meta?: Record<string, unknown>;
  files?: MessageFile[];
  createdAt: string;
  reactions: Reaction[];
}

export interface Agent {
  id: string;
  serverId: string;
  name: string;
  avatarUrl?: string;
  bio?: string;
  statusText?: string;
  roleId?: string;
  isManager: boolean;
  systemPrompt: string;
  modelClass: ModelClass;
  effort: Effort;
  personality: number;
  enabledTools: string[];
  memoryScope?: string;
  proactivity?: Record<string, unknown>;
  requiresApproval: boolean;
  status: AgentStatus;
  thinkingLine?: string;
  enabled: boolean;
  roleColor?: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelClass: ModelClass;
  effort: Effort;
  personality: number;
  enabledTools: string[];
  isManager: boolean;
}

export interface Tool {
  name: string;
  description: string;
  requiresApproval: boolean;
}

export interface BrainNote {
  id: string;
  folder?: string;
  title: string;
  summary?: string;
  content?: string;
  updatedAt: string;
}

// An outgoing [[wikilink]] from a note (noteId is null if it points nowhere yet).
export interface NoteLink {
  target: string;
  label: string;
  noteId: string | null;
  folder: string | null;
  title: string;
}

// A note that links back to the current one.
export interface NoteBacklink {
  id: string;
  title: string;
  folder?: string;
}

// The Brain's [[wikilink]] graph.
export interface GraphNode {
  id: string;
  title: string;
  folder: string;
}
export interface GraphEdge {
  source: string;
  target: string;
}

export interface Proposal {
  id: string;
  serverId: string;
  noteId?: string;
  title?: string;
  content?: string;
  status: ProposalStatus;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignedAgentId?: string;
  channelId?: string;
  mode?: string;
  result?: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  action: string;
  summary: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  kind?: string;
  title: string;
  body?: string;
  read: boolean;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  label?: string;
  last4: string;
  valid: boolean;
  createdAt: string;
}

export interface ProviderStatus {
  mode: 'apikey' | 'subscription';
  selfHosted: boolean;
  subscriptionAvailable: boolean;
  claudeLoginDetected: boolean;
  hasSubscription: boolean;
  hasKey: boolean;
}

// ── Workflows (n8n-style automations) ────────────────────────────────────────
export interface WorkflowNode {
  id: string;
  type: string; // 'trigger.manual' | 'trigger.schedule' | 'agent.run' | 'channel.post' | 'brain.write' | 'condition'
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}
export interface WorkflowEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
export interface Workflow {
  id: string;
  serverId: string;
  name: string;
  description?: string;
  enabled: boolean;
  graph: WorkflowGraph;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowRunLog {
  nodeId: string;
  type: string;
  status: 'ok' | 'error' | 'skipped';
  output?: string;
  error?: string;
}
export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: 'running' | 'ok' | 'error';
  trigger: string;
  log: WorkflowRunLog[];
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface ActivityRun {
  id: string;
  agentId?: string;
  agentName: string;
  trigger: string;
  model: string;
  status: 'ok' | 'error' | 'parked';
  error?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  tools: string[];
  channelId?: string | null;
  taskId?: string | null;
  createdAt: string;
}

export interface SearchResults {
  messages: { id: string; channelId: string | null; channelName: string | null; excerpt: string; who: string; createdAt: string }[];
  notes: { id: string; title: string; folder: string; summary: string }[];
  tasks: { id: string; title: string; status: string }[];
  agents: { id: string; name: string; description: string }[];
  workflows: { id: string; name: string }[];
}

export interface UsageData {
  totalCost: number;
  totalRuns: number;
  costOverTime: { date: string; cost: number }[];
  perAgent: { agentId: string; agentName: string; cost: number; runs: number }[];
  tokensByModel: { model: string; input: number; output: number }[];
  topTasks: { taskId: string; title: string; cost: number }[];
}

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  agentId?: string;
  channelId?: string;
  enabled: boolean;
}

export interface Hook {
  id: string;
  name: string;
  trigger: 'new_file' | 'keyword' | 'webhook';
  config: Record<string, unknown>;
  agentId: string;
  channelId?: string;
  promptTemplate: string;
  enabled: boolean;
}

export interface Invite {
  code: string;
  role?: MemberRole;
  maxUses?: number;
  expiresAt?: string;
}

export interface RunParkedEvent {
  serverId: string;
  agentId: string;
  resetAt?: string;
  runId?: string;
}

export interface PlanStep {
  id: string;
  order: number;
  title: string;
  agentName?: string | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string | null;
}

export interface Plan {
  id: string;
  serverId: string;
  agentId?: string | null;
  goal: string;
  status: 'active' | 'done' | 'failed';
  steps: PlanStep[];
  createdAt: string;
}

export interface AgentQuestion {
  id: string;
  agentId: string;
  prompt: string;
  kind: 'open' | 'choice';
  options: string[];
  status: 'pending' | 'answered';
  answer?: string | null;
}

export interface EmailDraft {
  id: string;
  agentId: string;
  fromAddr?: string | null;
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  status: 'pending' | 'sent' | 'discarded';
  sentAt?: string | null;
}

export interface VaultEntry {
  id: string;
  token: string;
  label?: string | null;
  kind: 'custom' | 'email' | 'phone' | 'iban' | 'card';
  auto: boolean;
  hits: number;
  /** Masked preview — the real value never leaves the server. */
  preview: string;
}
