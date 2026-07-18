import type {
  User, Server, ServerMember, ServerSettings, Channel, Message, Agent, AgentTemplate,
  Tool, BrainNote, NoteLink, NoteBacklink, GraphNode, GraphEdge, Proposal, Task, Approval, Notification, ApiKey, ProviderStatus,
  UsageData, Schedule, Invite, MemberRole, Reaction, Workflow, WorkflowRun, WorkflowGraph, MessageFile, SearchResults, ActivityRun, Hook, Plan, AgentQuestion, EmailDraft,
} from './types';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = await res.json();
      if (j.error) message = j.error;
    } catch {}
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return {} as T;
  return res.json();
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body);
const del = <T>(path: string) => request<T>('DELETE', path);

// Auth
export const auth = {
  me: () => get<{ user: User }>('/auth/me'),
  login: (email: string, password: string) => post<{ user: User }>('/auth/login', { email, password }),
  register: (email: string, password: string, displayName: string) =>
    post<{ user: User }>('/auth/register', { email, password, displayName }),
  logout: () => post<{ ok: boolean }>('/auth/logout'),
};

// API Keys
export const apiKeys = {
  list: () => get<{ keys: ApiKey[] }>('/api-keys'),
  create: (label: string | undefined, key: string, kind: 'api' | 'subscription' = 'api') =>
    post<{ key: ApiKey; valid: boolean; error?: string }>('/api-keys', { label, key, kind }),
  // Connect the machine's existing Claude login (no token needed).
  connectExistingLogin: () =>
    post<{ key: ApiKey; valid: boolean; error?: string }>('/api-keys', { kind: 'subscription', useExistingLogin: true }),
  delete: (id: string) => del<{ ok: boolean }>(`/api-keys/${id}`),
  providerStatus: () => get<ProviderStatus>('/provider/status'),
};

// Servers
export const servers = {
  list: () => get<{ servers: Server[] }>('/servers'),
  create: (name: string, description?: string) => post<{ server: Server }>('/servers', { name, description }),
  get: (serverId: string) => get<{ server: Server; members: ServerMember[]; settings: ServerSettings }>(`/servers/${serverId}`),
  patch: (serverId: string, body: Partial<Server & { settings: Partial<ServerSettings> }>) =>
    patch<{ server: Server }>(`/servers/${serverId}`, body),
  delete: (serverId: string) => del<{ ok: boolean }>(`/servers/${serverId}`),
  pauseAll: (serverId: string) => post<{ ok: boolean }>(`/servers/${serverId}/pause-all`),
  resumeAll: (serverId: string) => post<{ ok: boolean }>(`/servers/${serverId}/resume-all`),
};

// Invites
export const invites = {
  create: (serverId: string, body: { role?: MemberRole; maxUses?: number; expiresAt?: string }) =>
    post<{ invite: Invite }>(`/servers/${serverId}/invites`, body),
  preview: (code: string) => get<{ server: { name: string }; valid: boolean }>(`/invites/${code}`),
  accept: (code: string) => post<{ server: Server }>(`/invites/${code}/accept`),
};

// Channels
export const channels = {
  list: (serverId: string) => get<{ channels: Channel[] }>(`/servers/${serverId}/channels`),
  create: (serverId: string, name: string, topic?: string) =>
    post<{ channel: Channel }>(`/servers/${serverId}/channels`, { name, topic }),
  patch: (serverId: string, channelId: string, body: { name?: string; topic?: string }) =>
    patch<{ channel: Channel }>(`/servers/${serverId}/channels/${channelId}`, body),
  delete: (serverId: string, channelId: string) =>
    del<{ ok: boolean }>(`/servers/${serverId}/channels/${channelId}`),
};

// Messages
export const messages = {
  list: (serverId: string, channelId: string, before?: string, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    return get<{ messages: Message[] }>(`/servers/${serverId}/channels/${channelId}/messages?${params}`);
  },
  send: (serverId: string, channelId: string, content: string, contentType?: string, fileIds?: string[]) =>
    post<{ message: Message }>(`/servers/${serverId}/channels/${channelId}/messages`, { content, contentType, fileIds }),
  dmList: (serverId: string, agentId: string) =>
    get<{ messages: Message[] }>(`/servers/${serverId}/dms/${agentId}/messages`),
  dmSend: (serverId: string, agentId: string, content: string) =>
    post<{ message: Message }>(`/servers/${serverId}/dms/${agentId}/messages`, { content }),
};

// Reactions
export const reactions = {
  add: (serverId: string, messageId: string, kind: 'up' | 'down', feedback?: string) =>
    post<{ reaction: Reaction }>(`/servers/${serverId}/messages/${messageId}/reactions`, { kind, feedback }),
  remove: (serverId: string, messageId: string, kind: 'up' | 'down') =>
    del<{ ok: boolean }>(`/servers/${serverId}/messages/${messageId}/reactions/${kind}`),
};

// Agents
export const agents = {
  list: (serverId: string) => get<{ agents: Agent[] }>(`/servers/${serverId}/agents`),
  create: (serverId: string, body: Partial<Agent>) => post<{ agent: Agent }>(`/servers/${serverId}/agents`, body),
  get: (serverId: string, agentId: string) => get<{ agent: Agent }>(`/servers/${serverId}/agents/${agentId}`),
  patch: (serverId: string, agentId: string, body: Partial<Agent>) =>
    patch<{ agent: Agent }>(`/servers/${serverId}/agents/${agentId}`, body),
  delete: (serverId: string, agentId: string) => del<{ ok: boolean }>(`/servers/${serverId}/agents/${agentId}`),
  pause: (serverId: string, agentId: string) => post<{ agent: Agent }>(`/servers/${serverId}/agents/${agentId}/pause`),
  resume: (serverId: string, agentId: string) => post<{ agent: Agent }>(`/servers/${serverId}/agents/${agentId}/resume`),
  templates: () => get<{ templates: AgentTemplate[] }>('/agent-templates'),
  tools: () => get<{ tools: Tool[] }>('/tools'),
};

// Brain
export const brain = {
  listNotes: (serverId: string) => get<{ notes: BrainNote[] }>(`/servers/${serverId}/brain/notes`),
  getNote: (serverId: string, noteId: string) =>
    get<{ note: BrainNote; links: NoteLink[]; backlinks: NoteBacklink[] }>(`/servers/${serverId}/brain/notes/${noteId}`),
  graph: (serverId: string) =>
    get<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/servers/${serverId}/brain/graph`),
  createNote: (serverId: string, body: { folder?: string; title: string; summary?: string; content: string }) =>
    post<{ note: BrainNote }>(`/servers/${serverId}/brain/notes`, body),
  patchNote: (serverId: string, noteId: string, body: Partial<BrainNote>) =>
    patch<{ note: BrainNote }>(`/servers/${serverId}/brain/notes/${noteId}`, body),
  deleteNote: (serverId: string, noteId: string) => del<{ ok: boolean }>(`/servers/${serverId}/brain/notes/${noteId}`),
  listProposals: (serverId: string, status = 'PENDING') =>
    get<{ proposals: Proposal[] }>(`/servers/${serverId}/brain/proposals?status=${status}`),
  approveProposal: (serverId: string, id: string) =>
    post<{ note: BrainNote }>(`/servers/${serverId}/brain/proposals/${id}/approve`),
  rejectProposal: (serverId: string, id: string) =>
    post<{ ok: boolean }>(`/servers/${serverId}/brain/proposals/${id}/reject`),
};

// Tasks
export const tasks = {
  list: (serverId: string) => get<{ tasks: Task[] }>(`/servers/${serverId}/tasks`),
  create: (serverId: string, body: { title: string; description?: string; assignedAgentId?: string; channelId?: string; mode?: string }) =>
    post<{ task: Task }>(`/servers/${serverId}/tasks`, body),
  patch: (serverId: string, taskId: string, body: { status?: string; result?: string; assignedAgentId?: string }) =>
    patch<{ task: Task }>(`/servers/${serverId}/tasks/${taskId}`, body),
};

// Approvals
export const approvals = {
  list: (serverId: string, status = 'PENDING') =>
    get<{ approvals: Approval[] }>(`/servers/${serverId}/approvals?status=${status}`),
  approve: (serverId: string, id: string) => post<{ approval: Approval }>(`/servers/${serverId}/approvals/${id}/approve`),
  reject: (serverId: string, id: string) => post<{ approval: Approval }>(`/servers/${serverId}/approvals/${id}/reject`),
};

// Usage
export const usage = {
  server: (serverId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const q = params.toString();
    return get<UsageData>(`/servers/${serverId}/usage${q ? '?' + q : ''}`);
  },
  global: () => get<{ perServer: { serverId: string; name: string; cost: number }[] }>('/usage'),
};

// Notifications
export const notifications = {
  list: (unread?: boolean) => get<{ notifications: Notification[] }>(`/notifications${unread ? '?unread=true' : ''}`),
  read: (id: string) => post<{ ok: boolean }>(`/notifications/${id}/read`),
  readAll: () => post<{ ok: boolean }>('/notifications/read-all'),
};

// Schedules
export const schedules = {
  list: (serverId: string) => get<{ schedules: Schedule[] }>(`/servers/${serverId}/schedules`),
  create: (serverId: string, body: Omit<Schedule, 'id'>) =>
    post<{ schedule: Schedule }>(`/servers/${serverId}/schedules`, body),
  patch: (serverId: string, id: string, body: Partial<Schedule>) =>
    patch<{ schedule: Schedule }>(`/servers/${serverId}/schedules/${id}`, body),
  delete: (serverId: string, id: string) => del<{ ok: boolean }>(`/servers/${serverId}/schedules/${id}`),
};

// Workflows (n8n-style automations)
export const workflows = {
  list: (serverId: string) => get<{ workflows: Workflow[] }>(`/servers/${serverId}/workflows`),
  get: (serverId: string, id: string) => get<{ workflow: Workflow; runs: WorkflowRun[] }>(`/servers/${serverId}/workflows/${id}`),
  create: (serverId: string, body: { name: string; description?: string; graph?: WorkflowGraph; enabled?: boolean }) =>
    post<{ workflow: Workflow }>(`/servers/${serverId}/workflows`, body),
  patch: (serverId: string, id: string, body: { name?: string; description?: string; enabled?: boolean; graph?: WorkflowGraph }) =>
    patch<{ workflow: Workflow }>(`/servers/${serverId}/workflows/${id}`, body),
  delete: (serverId: string, id: string) => del<{ ok: boolean }>(`/servers/${serverId}/workflows/${id}`),
  run: (serverId: string, id: string) => post<{ run: { id: string; status: string } }>(`/servers/${serverId}/workflows/${id}/run`),
};

// Plans (Manager plan-then-execute)
export const plans = {
  list: (serverId: string, status?: string) =>
    get<{ plans: Plan[] }>(`/servers/${serverId}/plans${status ? `?status=${status}` : ''}`),
  get: (serverId: string, id: string) => get<{ plan: Plan }>(`/servers/${serverId}/plans/${id}`),
};

// Email (IMAP/SMTP)
export interface EmailStatus { connected: boolean; email?: string; imapHost?: string; smtpHost?: string }
export const email = {
  status: (serverId: string) => get<EmailStatus>(`/servers/${serverId}/email`),
  connect: (serverId: string, body: { email: string; password: string; provider: string; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number }) =>
    post<{ connected: boolean; email: string }>(`/servers/${serverId}/email`, body),
  disconnect: (serverId: string) => del<{ connected: boolean }>(`/servers/${serverId}/email`),
};

// MCP servers (external tools)
export interface McpServerView { id: string; name: string; transport: 'stdio' | 'sse' | 'http'; command?: string | null; args: string[]; url?: string | null; enabled: boolean }
export const mcp = {
  list: (serverId: string) => get<{ servers: McpServerView[] }>(`/servers/${serverId}/mcp`),
  create: (serverId: string, body: { name: string; transport: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> }) =>
    post<{ server: McpServerView }>(`/servers/${serverId}/mcp`, body),
  patch: (serverId: string, id: string, body: { enabled?: boolean }) => patch<{ server: McpServerView }>(`/servers/${serverId}/mcp/${id}`, body),
  delete: (serverId: string, id: string) => del<{ ok: boolean }>(`/servers/${serverId}/mcp/${id}`),
  test: (serverId: string, id: string) => post<{ ok: boolean; tools?: string[]; error?: string }>(`/servers/${serverId}/mcp/${id}/test`),
};

// Interactive agent question cards
export const questions = {
  get: (serverId: string, id: string) => get<{ question: AgentQuestion }>(`/servers/${serverId}/questions/${id}`),
  answer: (serverId: string, id: string, answer: string) =>
    post<{ question: AgentQuestion }>(`/servers/${serverId}/questions/${id}/answer`, { answer }),
};

// Email drafts: preview → edit inline / ask the agent to revise / send.
export const emailDrafts = {
  get: (serverId: string, id: string) => get<{ draft: EmailDraft }>(`/servers/${serverId}/email-drafts/${id}`),
  patch: (serverId: string, id: string, data: Partial<Pick<EmailDraft, 'to' | 'cc' | 'subject' | 'body'>>) =>
    patch<{ draft: EmailDraft }>(`/servers/${serverId}/email-drafts/${id}`, data),
  send: (serverId: string, id: string) => post<{ draft: EmailDraft }>(`/servers/${serverId}/email-drafts/${id}/send`, {}),
  discard: (serverId: string, id: string) => post<{ draft: EmailDraft }>(`/servers/${serverId}/email-drafts/${id}/discard`, {}),
  revise: (serverId: string, id: string, instruction: string) =>
    post<{ draft: EmailDraft }>(`/servers/${serverId}/email-drafts/${id}/revise`, { instruction }),
};

// Workspace backup / restore
export const workspace = {
  export: (serverId: string) => get<Record<string, unknown>>(`/servers/${serverId}/export`),
  import: (serverId: string, data: unknown) =>
    post<{ ok: boolean; imported: Record<string, number> }>(`/servers/${serverId}/import`, data),
};

// Triggers (hooks)
export const hooks = {
  list: (serverId: string) => get<{ hooks: Hook[] }>(`/servers/${serverId}/hooks`),
  create: (serverId: string, body: Omit<Hook, 'id'>) => post<{ hook: Hook }>(`/servers/${serverId}/hooks`, body),
  patch: (serverId: string, id: string, body: Partial<Hook>) => patch<{ hook: Hook }>(`/servers/${serverId}/hooks/${id}`, body),
  delete: (serverId: string, id: string) => del<{ ok: boolean }>(`/servers/${serverId}/hooks/${id}`),
  webhookUrl: (serverId: string) => get<WebhookInfo>(`/servers/${serverId}/hooks/webhook`),
  patchWebhook: (serverId: string, body: { requireSignature?: boolean; rotate?: boolean }) =>
    patch<WebhookInfo>(`/servers/${serverId}/hooks/webhook`, body),
  tunnelStatus: (serverId: string) => get<TunnelStatus>(`/servers/${serverId}/hooks/tunnel`),
  tunnelStart: (serverId: string) => post<TunnelStatus>(`/servers/${serverId}/hooks/tunnel/start`),
  tunnelStop: (serverId: string) => post<TunnelStatus>(`/servers/${serverId}/hooks/tunnel/stop`),
};

export interface WebhookInfo { url: string; secret: string; requireSignature: boolean }
export interface TunnelStatus { running: boolean; url: string | null }

// Activity (agent run timeline)
export const activity = {
  list: (serverId: string, opts?: { before?: string; agentId?: string; status?: string }) => {
    const p = new URLSearchParams();
    if (opts?.before) p.set('before', opts.before);
    if (opts?.agentId) p.set('agentId', opts.agentId);
    if (opts?.status) p.set('status', opts.status);
    const q = p.toString();
    return get<{ runs: ActivityRun[] }>(`/servers/${serverId}/activity${q ? '?' + q : ''}`);
  },
};

// Global search
export const search = {
  query: (serverId: string, q: string) =>
    get<{ results: SearchResults }>(`/servers/${serverId}/search?q=${encodeURIComponent(q)}`),
};

// Files
export const files = {
  upload: (serverId: string, file: File, channelId?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (channelId) fd.append('channelId', channelId);
    return fetch(`/servers/${serverId}/files`, { method: 'POST', credentials: 'include', body: fd })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'upload failed');
        return r.json() as Promise<{ file: MessageFile }>;
      });
  },
};
