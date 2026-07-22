import { z } from 'zod';
import { query, tool, createSdkMcpServer, type McpServerConfig, type SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { AgentModelClass, AgentEffort } from '@prisma/client';
import {
  type LLMProvider,
  type LLMRunParams,
  type LLMStreamEvent,
  type LLMResult,
  type AgenticRunParams,
  LLMRateLimitError,
  LLMAuthError,
} from './types.js';
import { logger } from '../lib/logger.js';
import { resolveInProject } from '../tools/coding.js';

/**
 * Agent SDK subscription backend (self-hosted, individual use only).
 *
 * DISCLAIMER: authenticates with YOUR OWN Claude subscription (Pro/Max/Team/
 * Enterprise) via a token from `claude setup-token`, set as
 * CLAUDE_CODE_OAUTH_TOKEN. Usage draws from your plan's limits instead of
 * pay-per-token. This is for individual use of your own subscription on your own
 * machine — never pool, proxy, or resell subscription access. Anthropic's policy
 * here has changed before and this mode may stop working.
 *
 * The Agent SDK owns the agent loop, so we map our tool registry onto SDK
 * in-process MCP tools rather than running our own tool loop.
 */

// Subscription runs use model aliases (whatever the plan grants).
const SUB_MODEL: Record<AgentModelClass, string> = {
  HAIKU: 'haiku',
  SONNET: 'sonnet',
  OPUS: 'opus',
};
const SUB_EFFORT: Record<AgentEffort, 'low' | 'medium' | 'high'> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

const MCP_NAME = 'cc';

// Canonical tool name (see tools/coding.ts) → the Claude Agent SDK's matching
// built-in. Only meaningful when a workspace has a project folder set — see
// runAgentic below.
const CODING_TOOL_MAP: Record<string, string> = {
  project_read_file: 'Read',
  project_list_dir: 'Glob',
  project_search: 'Grep',
  project_write_file: 'Write',
  project_edit_file: 'Edit',
  project_run_bash: 'Bash',
};

function codingBuiltinsFor(toolNames: string[]): string[] {
  const out: string[] = [];
  for (const n of toolNames) {
    const builtin = CODING_TOOL_MAP[n];
    if (builtin) out.push(builtin);
  }
  return out;
}

// Which input field of each SDK built-in carries a filesystem path the model
// controls. Bash has none — its cwd is already pinned to projectDir when
// mounted (see runAgentic), and a `cd` inside the command is the same
// disclosed, unfenced gap project_run_bash already has.
const CODING_PATH_FIELD: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Glob: 'path',
  Grep: 'path',
};

// Reject a coding built-in call whose path argument (relative or absolute)
// would resolve outside projectDir. Read/Write/Edit's file_path is normally
// absolute — path.resolve leaves an absolute path untouched, so
// resolveInProject still catches it via the containment check. A tool with no
// path field (e.g. Glob/Grep with no `path`, defaulting to cwd) is allowed —
// cwd is already projectDir.
function fenceViolation(toolName: string, toolInput: Record<string, unknown>, projectDir: string): string | null {
  const field = CODING_PATH_FIELD[toolName];
  if (!field) return null;
  const raw = toolInput[field];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return resolveInProject(projectDir, raw) ? null : `"${raw}" is outside the project folder.`;
}

export class SubscriptionProvider implements LLMProvider {
  readonly mode = 'subscription' as const;
  readonly ownsAgentLoop = true;

  // No token → "ambient" mode: the SDK reads the machine's existing Claude
  // login (~/.claude credentials from `claude login` / Claude Code).
  constructor(private oauthToken?: string) {}

  private applyAuth() {
    // Never let an API key take precedence — force subscription auth.
    delete process.env.ANTHROPIC_API_KEY;
    if (this.oauthToken) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = this.oauthToken;
    } else {
      // Ambient: let the SDK use the stored Claude login; clear any stale token.
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  }

  async validate(): Promise<{ ok: boolean; error?: string }> {
    this.applyAuth();
    try {
      const q = query({
        prompt: 'Reply with the single word: ok',
        options: { model: 'haiku', maxTurns: 1, systemPrompt: 'You are a terse assistant.', settingSources: [] },
      });
      for await (const msg of q) {
        if (msg.type === 'result') {
          return (msg as { subtype?: string }).subtype === 'error_during_execution'
            ? { ok: false, error: 'run failed' }
            : { ok: true };
        }
      }
      return { ok: true };
    } catch (err) {
      throw normalizeError(err);
    }
  }

  // Single-turn interface is not used in this mode (the SDK owns the loop).
  async run(_params: LLMRunParams): Promise<LLMResult> {
    throw new Error('SubscriptionProvider owns the agent loop; use runAgentic().');
  }

  async runAgentic(params: AgenticRunParams, onEvent?: (e: LLMStreamEvent) => void): Promise<LLMResult> {
    this.applyAuth();

    // `web_search` in our registry is a capability flag, not a real client-side
    // tool: it switches on the SDK's native WebSearch (which runs server-side).
    // We drop our stub so the model sees exactly one search tool. The six
    // project_* coding tools are handled the same way, in favor of the SDK's
    // own built-ins — see codingBuiltinsFor.
    const wantsWebSearch = params.tools.some((t) => t.name === 'web_search');
    const codingBuiltins = params.projectDir ? codingBuiltinsFor(params.tools.map((t) => t.name)) : [];
    const ourTools = params.tools.filter((t) => t.name !== 'web_search' && !(t.name in CODING_TOOL_MAP));

    // Map our tools onto SDK in-process MCP tools.
    const sdkTools = ourTools.map((spec) =>
      tool(
        spec.name,
        spec.description,
        jsonSchemaToZodShape(spec.input_schema),
        async (input: Record<string, unknown>) => {
          onEvent?.({ type: 'tool_use', id: '', name: spec.name, input });
          const out = await params.executeTool(spec.name, input);
          return { content: [{ type: 'text' as const, text: out }] };
        },
      ),
    );
    const server = createSdkMcpServer({ name: MCP_NAME, version: '1.0.0', tools: sdkTools });
    const allowed = ourTools.map((t) => `mcp__${MCP_NAME}__${t.name}`);
    if (wantsWebSearch) allowed.push('WebSearch');
    // Mount external MCP servers alongside our in-process one.
    const externalMcp = (params.mcpServers ?? {}) as Record<string, McpServerConfig>;

    const model = SUB_MODEL[params.modelClass];
    let lastRateLimit: SDKRateLimitInfo | undefined;
    let text = '';
    let costUsd = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const turnUsage: Array<{ in: number; out: number; cacheR: number; cacheW: number }> = [];

    try {
      const q = query({
        prompt: params.prompt,
        options: {
          model,
          systemPrompt: params.system,
          mcpServers: { [MCP_NAME]: server, ...externalMcp },
          allowedTools: allowed,
          // Drop the SDK's built-in toolset (Read/Write/Edit/Bash/Glob/Grep/
          // Task/TodoWrite/…) UNLESS the workspace has a project folder set and
          // the agent has the matching project_* tool enabled — in which case
          // ship exactly those built-ins (codingBuiltins) and no others.
          // canUseTool already denies anything not explicitly listed here, but
          // an unused built-in's schema still costs real tokens on every
          // request — measured at the bulk of a ~14k-token per-call overhead.
          tools: [...(wantsWebSearch ? ['WebSearch'] : []), ...codingBuiltins],
          cwd: codingBuiltins.length ? params.projectDir : undefined,
          // Permit our tools + any mounted MCP server's tools (all mcp__ prefixed)
          // + WebSearch (if granted) + the coding built-ins translated above.
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
            if (toolName.startsWith('mcp__') || (wantsWebSearch && toolName === 'WebSearch')) {
              return { behavior: 'allow' as const, updatedInput: toolInput };
            }
            if (codingBuiltins.includes(toolName)) {
              const violation = fenceViolation(toolName, toolInput, params.projectDir!);
              if (violation) return { behavior: 'deny' as const, message: violation };
              return { behavior: 'allow' as const, updatedInput: toolInput };
            }
            return { behavior: 'deny' as const, message: 'Only Claude Control + mounted MCP tools are permitted.' };
          },
          settingSources: [],
          // Skills are a Claude Code feature our agents never use — they work
          // through our own MCP tools. Omitting this option does NOT disable
          // them (the CLI's defaults still apply and their listing rides in the
          // prompt), so turn them off explicitly.
          skills: [],
          maxTurns: params.maxTurns ?? 8,
          effort: SUB_EFFORT[params.effort],
        },
      });

      for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
        const type = msg.type as string;
        if (type === 'rate_limit_event') {
          // Subscription quota telemetry the SDK emits alongside normal traffic
          // (status 'allowed' on a healthy run — NOT an error). When it says
          // 'rejected' we get the exact reset epoch, which beats scraping a time
          // out of an error string: park now and let the ResumeJob fire on it.
          const info = (msg as { rate_limit_info?: SDKRateLimitInfo }).rate_limit_info;
          if (info) {
            lastRateLimit = info;
            if (info.status === 'rejected') {
              throw new LLMRateLimitError(
                `Subscription limit reached (${info.rateLimitType ?? 'usage'}).`,
                info.resetsAt ? new Date(info.resetsAt * 1000) : undefined,
                info.resetsAt ? undefined : 30 * 60_000,
              );
            }
          }
        } else if (type === 'assistant') {
          // Per-REQUEST usage. The final `result` message reports a total, which
          // is where a per-turn cache read would disappear: turn 1 writes the
          // cache and turns 2..n read it, but if the SDK's total only carries
          // the last turn (or resets), cacheR reads 0 for the whole run even
          // though caching worked. Log each turn to tell those apart.
          const turn = (msg.message as { usage?: Record<string, number> })?.usage;
          if (turn) {
            turnUsage.push({
              in: turn.input_tokens ?? 0,
              out: turn.output_tokens ?? 0,
              cacheR: turn.cache_read_input_tokens ?? 0,
              cacheW: turn.cache_creation_input_tokens ?? 0,
            });
          }
          const content = (msg.message as { content?: unknown[] })?.content ?? (msg as { content?: unknown[] }).content ?? [];
          for (const block of content as Array<{ type: string; text?: string; thinking?: string; name?: string }>) {
            if (block.type === 'text' && block.text) {
              text += block.text;
            } else if (block.type === 'thinking') {
              onEvent?.({ type: 'thinking_delta', text: '' });
            } else if (block.type === 'tool_use' && block.name === 'WebSearch') {
              // Runs server-side inside the model call, so it never reaches our
              // executeTool — surface it for status + run.tools observability.
              onEvent?.({ type: 'tool_use', id: '', name: 'web_search', input: {} });
            } else if (block.type === 'tool_use' && block.name && block.name.startsWith('mcp__') && !block.name.startsWith(`mcp__${MCP_NAME}__`)) {
              // External MCP tool calls run inside the SDK (not our executeTool),
              // so surface them here for status + run.tools observability.
              onEvent?.({ type: 'tool_use', id: '', name: block.name, input: {} });
            }
          }
        } else if (type === 'result') {
          const r = msg as {
            result?: string;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
            is_error?: boolean;
            subtype?: string;
          };
          if (typeof r.result === 'string' && r.result) text = r.result;
          if (typeof r.total_cost_usd === 'number') costUsd = r.total_cost_usd;
          if (r.usage) {
            usage.inputTokens += r.usage.input_tokens ?? 0;
            usage.outputTokens += r.usage.output_tokens ?? 0;
            usage.cacheReadTokens += r.usage.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens += r.usage.cache_creation_input_tokens ?? 0;
          }
          if (r.is_error || r.subtype === 'error_max_turns') {
            // treat max-turns / execution errors as a soft stop, not a crash
          }
        }
      }
    } catch (err) {
      throw normalizeError(err);
    }

    // Settle where the tokens actually went. The `result` total and the sum of
    // per-turn usage should agree; when they don't, the total is the unreliable
    // one (it has been observed to carry only the final turn), so prefer the
    // per-turn sum for cache figures — otherwise a working cache reports 0.
    const perTurn = turnUsage.reduce(
      (a, t) => ({
        inputTokens: a.inputTokens + t.in,
        outputTokens: a.outputTokens + t.out,
        cacheReadTokens: a.cacheReadTokens + t.cacheR,
        cacheWriteTokens: a.cacheWriteTokens + t.cacheW,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    if (perTurn.cacheReadTokens > usage.cacheReadTokens) {
      logger.info('cache: per-turn sum exceeds result total — using per-turn', {
        resultCacheR: usage.cacheReadTokens,
        perTurnCacheR: perTurn.cacheReadTokens,
        turns: turnUsage.length,
      });
      usage.cacheReadTokens = perTurn.cacheReadTokens;
      usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, perTurn.cacheWriteTokens);
    }
    logger.debug('cache: per-turn usage', { turns: turnUsage, result: usage });

    if (lastRateLimit && (lastRateLimit.status === 'allowed_warning' || (lastRateLimit.utilization ?? 0) >= 0.8)) {
      logger.warn('subscription quota running low', {
        status: lastRateLimit.status,
        utilization: lastRateLimit.utilization,
        type: lastRateLimit.rateLimitType,
        resetsAt: lastRateLimit.resetsAt ? new Date(lastRateLimit.resetsAt * 1000).toISOString() : undefined,
      });
    }

    return {
      content: text ? [{ type: 'text', text }] : [],
      text,
      toolUses: [],
      stopReason: 'end_turn',
      model,
      usage,
      // Subscription cost is drawn from the plan; we surface the equivalent USD.
      costUsdOverride: costUsd,
    };
  }
}

// Convert one of our JSON-schema tool input schemas into a Zod raw shape.
function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(props)) {
    let zt = mapType(def);
    if (typeof def.description === 'string') zt = zt.describe(def.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

function mapType(def: Record<string, unknown>): z.ZodTypeAny {
  const t = def.type as string | undefined;
  if (Array.isArray(def.enum) && def.enum.every((v) => typeof v === 'string')) {
    return z.enum(def.enum as [string, ...string[]]);
  }
  switch (t) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      // Recurse into `items`. Hard-coding z.array(z.string()) told the model
      // every array was a list of strings, silently discarding item schemas —
      // so create_workflow's [{type:'agent'|'post'|'brain', ...}] arrived as
      // bare strings, the enum never reached the model, and the resulting
      // workflow was built from defaults. (Same cause as the create_plan bug
      // fixed earlier by patching the symptom.)
      return z.array(def.items && typeof def.items === 'object' ? mapType(def.items as Record<string, unknown>) : z.unknown());
    case 'object': {
      // Preserve declared properties so nested objects keep their shape;
      // fall back to a loose record only when none are declared.
      const props = def.properties as Record<string, Record<string, unknown>> | undefined;
      if (!props) return z.record(z.string(), z.unknown());
      const required = new Set((def.required as string[]) ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, v] of Object.entries(props)) {
        let zt = mapType(v);
        if (typeof v.description === 'string') zt = zt.describe(v.description);
        if (!required.has(k)) zt = zt.optional();
        shape[k] = zt;
      }
      return z.object(shape);
    }
    default:
      return z.any();
  }
}

// Best-effort extraction of when a usage/rate limit resets, from the error text.
// Handles: a unix-seconds timestamp, an ISO datetime, or a clock time like
// "resets at 3:00pm" / "reset at 22:00". Returns undefined if nothing parseable.
export function parseResetAt(msg: string, now = new Date()): Date | undefined {
  // Unix seconds within the next 48h (Claude limit errors sometimes embed this).
  const epoch = msg.match(/\b(1[7-9]\d{8})\b/);
  if (epoch) {
    const d = new Date(Number(epoch[1]) * 1000);
    if (d.getTime() > now.getTime() && d.getTime() < now.getTime() + 48 * 3600_000) return d;
  }
  // ISO datetime.
  const iso = msg.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)\b/);
  if (iso) {
    const d = new Date(iso[1]);
    if (!Number.isNaN(d.getTime()) && d.getTime() > now.getTime()) return d;
  }
  // Clock time, e.g. "reset(s) at 3:00 pm" or "reset at 22:00". The trailing
  // (?!\d) stops it from matching the leading digits of a bare epoch number.
  const clock = msg.match(/reset[s]?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?!\d)/i);
  if (clock) {
    let hour = Number(clock[1]);
    const min = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour <= 23 && min <= 59) {
      const d = new Date(now);
      d.setHours(hour, min, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // next occurrence
      return d;
    }
  }
  return undefined;
}

function normalizeError(err: unknown): Error {
  const msg = (err as Error)?.message ?? String(err);
  const low = msg.toLowerCase();
  if (low.includes('usage limit') || low.includes('rate limit') || low.includes('429') || low.includes('quota') || low.includes('overloaded')) {
    // Subscription usage window exhausted — park and auto-resume at the reset
    // time if we can read it, else poll every 30 min until it clears.
    const resetAt = parseResetAt(msg);
    return new LLMRateLimitError(msg, resetAt, resetAt ? undefined : 30 * 60_000);
  }
  if (low.includes('401') || low.includes('unauthorized') || low.includes('auth') || low.includes('token')) {
    return new LLMAuthError('Subscription token invalid or expired. Re-run `claude setup-token` and reconnect.');
  }
  return err instanceof Error ? err : new Error(msg);
}

// Exposed for tests: the JSON-schema -> zod conversion is easy to break in ways
// that only show up as a model silently receiving the wrong tool shape, and
// codingBuiltinsFor is easy to break in ways that only show up as an agent
// silently missing (or wrongly gaining) a built-in tool.
export const __testing = { jsonSchemaToZodShape, mapType, codingBuiltinsFor, fenceViolation };
