import type { AgentModelClass, AgentEffort } from '@prisma/client';
import type { TokenUsage } from './pricing.js';

// ─── Normalized message / content model ─────────────────────────────────────
// The LLMProvider interface normalizes across backends (API key + Agent SDK) so
// the rest of the app never touches provider-specific shapes.

export interface LLMToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type LLMContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContentBlock[];
}

export interface LLMRunParams {
  system: string;
  messages: LLMMessage[];
  modelClass: AgentModelClass;
  effort: AgentEffort;
  tools?: LLMToolSpec[];
  // Adaptive thinking on/off. Off for terse agent-to-agent traffic.
  thinking?: boolean;
  maxTokens?: number;
}

// Streamed events feed socket status updates / thinking bubbles.
export type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'status'; line: string };

export interface LLMResult {
  content: LLMContentBlock[]; // assistant turn (text + tool_use blocks)
  text: string; // concatenated text blocks
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  model: string;
  usage: TokenUsage;
  // Some backends (subscription) report total cost directly; if set, the run
  // loop uses this instead of computing from the price table.
  costUsdOverride?: number;
}

// For backends that own the agent loop (e.g. the Agent SDK subscription
// backend): the run loop hands over the whole turn plus a tool executor bound
// to the run's ToolContext, and the provider drives the loop internally.
export interface AgenticRunParams {
  system: string;
  prompt: string;
  modelClass: AgentModelClass;
  effort: AgentEffort;
  tools: LLMToolSpec[];
  // Execute one of our registered tools (with approval/context already wired).
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  maxTurns?: number;
  // External MCP servers to mount ({ name → SDK config }); subscription mode only.
  mcpServers?: Record<string, unknown>;
  // Workspace's project folder (Server.settings.projectDir); subscription mode
  // only. Enables the SDK's own Read/Write/Edit/Glob/Grep/Bash for agents with
  // the matching project_* tool enabled — see subscription.ts's
  // codingBuiltinsFor. Unset ⇒ no coding tools, regardless of what the agent
  // has enabled.
  projectDir?: string;
}

export interface LLMProvider {
  readonly mode: 'apikey' | 'subscription';
  // When true, the run loop calls runAgentic() instead of driving its own tool loop.
  readonly ownsAgentLoop?: boolean;
  /** Execute a single model turn (streaming). The agent run loop drives the tool loop. */
  run(params: LLMRunParams, onEvent?: (e: LLMStreamEvent) => void): Promise<LLMResult>;
  /** Run the full agentic loop (only when ownsAgentLoop is true). */
  runAgentic?(params: AgenticRunParams, onEvent?: (e: LLMStreamEvent) => void): Promise<LLMResult>;
  /** Validate the credential with a tiny call. */
  validate(): Promise<{ ok: boolean; error?: string }>;
}

// ─── Normalized errors ──────────────────────────────────────────────────────

/** Thrown when the backend is rate-limited or the usage window is exhausted.
 *  The run loop parks the job and schedules an auto-resume (see §10). */
export class LLMRateLimitError extends Error {
  constructor(
    message: string,
    public resetAt?: Date,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LLMRateLimitError';
  }
}

/** Thrown when the credential is invalid/missing (surface to user, don't retry). */
export class LLMAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMAuthError';
  }
}

export type { TokenUsage, AgentModelClass, AgentEffort };
