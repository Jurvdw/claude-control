import Anthropic from '@anthropic-ai/sdk';
import { MODEL_IDS, EFFORT_MAP } from './pricing.js';
import {
  type LLMProvider,
  type LLMRunParams,
  type LLMStreamEvent,
  type LLMResult,
  type LLMContentBlock,
  type LLMMessage,
  type LLMToolSpec,
  LLMRateLimitError,
  LLMAuthError,
} from './types.js';

// Prompt-caching breakpoint.
const CACHE = { type: 'ephemeral' as const };

// Cache the last tool definition (renders before system, so it survives Brain-index changes).
export function withToolsCache(tools: LLMToolSpec[]): unknown[] {
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: CACHE } : t));
}

// Convert the system string to a cached text block (caches tools + system together).
export function withSystemCache(system: string): unknown {
  return [{ type: 'text', text: system, cache_control: CACHE }];
}

// Cache through the last message so tool-loop iterations re-read the prefix.
export function withMessageCache(messages: LLMMessage[]): unknown[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  return messages.map((m, i) => (i === lastIdx ? cacheLastBlock(m) : m));
}

function cacheLastBlock(msg: LLMMessage): unknown {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: [{ type: 'text', text: msg.content, cache_control: CACHE }] };
  }
  const blocks = msg.content;
  if (blocks.length === 0) return msg;
  const lastIdx = blocks.length - 1;
  const last = blocks[lastIdx];
  if (typeof last !== 'object' || last === null) return msg;
  return {
    role: msg.role,
    content: blocks.map((b, i) => (i === lastIdx ? { ...(b as object), cache_control: CACHE } : b)),
  };
}

// `web_search` in our registry is a capability flag, not a client-side tool:
// search runs server-side inside the model call. Granting it swaps the flag for
// Anthropic's real server tool, which the model then calls without ever
// reaching our execute().
//
// The `_20260209` variant (dynamic filtering) needs Opus 4.6+/Sonnet 4.6+;
// Haiku 4.5 predates it and must use the basic variant, so pick by model.
function webSearchTool(model: string): Record<string, unknown> {
  const type = model.startsWith('claude-haiku') ? 'web_search_20250305' : 'web_search_20260209';
  return { type, name: 'web_search', max_uses: 5 };
}

/** Build the request `tools` array: our client tools (cached) + server tools. */
export function buildToolsParam(tools: LLMToolSpec[], model: string): unknown[] {
  const ours = tools.filter((t) => t.name !== 'web_search');
  const wantsSearch = ours.length !== tools.length;
  // cache_control belongs on the last CLIENT tool: the server tool is appended
  // after it, but server-tool definitions are fixed strings, so the prefix
  // stays byte-stable and the breakpoint still covers everything before it.
  const out: unknown[] = ours.length ? withToolsCache(ours) : [];
  if (wantsSearch) out.push(webSearchTool(model));
  return out;
}

// API-key backend (default, stable, sellable). BYOK — the key belongs to the
// account and is decrypted just-in-time before constructing this client.
export class AnthropicApiKeyProvider implements LLMProvider {
  readonly mode = 'apikey' as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async validate(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.messages.create({
        model: MODEL_IDS.HAIKU,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: normalizeError(err).message };
    }
  }

  async run(params: LLMRunParams, onEvent?: (e: LLMStreamEvent) => void): Promise<LLMResult> {
    const model = MODEL_IDS[params.modelClass];
    const { effort, maxTokens } = EFFORT_MAP[params.effort];

    // Build request params. `output_config` + adaptive thinking are 2026 API
    // fields not yet in the SDK's TS types; cast at the call boundary.
    //
    // Prompt caching (§token efficiency): the stable prefix is tools → system →
    // messages. We place cache_control breakpoints so follow-up turns and every
    // tool-loop iteration re-read the prefix at ~10% cost instead of re-billing
    // the full prompt. Three breakpoints (of 4 allowed): tools, system, and the
    // last message — the tools breakpoint survives even when the Brain index
    // (inside system) changes, since tools render before system.
    const req: Record<string, unknown> = {
      model,
      max_tokens: params.maxTokens ?? maxTokens,
      system: withSystemCache(params.system),
      messages: withMessageCache(params.messages),
      output_config: { effort },
    };
    if (params.thinking) req.thinking = { type: 'adaptive' };
    if (params.tools?.length) {
      const tools = buildToolsParam(params.tools, model);
      if (tools.length) req.tools = tools;
    }

    try {
      const stream = this.client.messages.stream(req as never);

      stream.on('text', (delta: string) => onEvent?.({ type: 'text_delta', text: delta }));
      // thinking deltas (when thinking enabled)
      stream.on('streamEvent', (ev: unknown) => {
        const e = ev as { type?: string; delta?: { type?: string; thinking?: string } };
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
          onEvent?.({ type: 'thinking_delta', text: e.delta.thinking ?? '' });
        }
      });

      const message = await stream.finalMessage();

      const content: LLMContentBlock[] = [];
      const toolUses: LLMResult['toolUses'] = [];
      let text = '';
      for (const block of message.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
          text += block.text;
        } else if (block.type === 'tool_use') {
          const tu = {
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          };
          content.push({ type: 'tool_use', ...tu });
          toolUses.push(tu);
          onEvent?.({ type: 'tool_use', ...tu });
        } else {
          // Server-tool blocks (server_tool_use, web_search_tool_result). We
          // don't model these, but they MUST be echoed back verbatim when
          // resuming a pause_turn — dropping them breaks the resume. Nothing
          // downstream reads them; block walkers key off `type` and skip.
          content.push(block as unknown as LLMContentBlock);
          if (block.type === 'server_tool_use') {
            onEvent?.({ type: 'status', line: 'Searching the web…' });
          }
        }
      }

      const u = message.usage as unknown as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      return {
        content,
        text,
        toolUses,
        stopReason: message.stop_reason ?? 'end_turn',
        model,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (err) {
      throw normalizeError(err);
    }
  }
}

// Normalize provider errors into the app's error taxonomy.
function normalizeError(err: unknown): Error {
  const e = err as { status?: number; message?: string; headers?: Record<string, string> };
  const status = e.status;
  if (status === 401 || status === 403) {
    return new LLMAuthError(e.message ?? 'invalid API key');
  }
  if (status === 429 || status === 529) {
    const retryAfter = e.headers?.['retry-after'];
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    const resetAt = retryAfterMs ? new Date(Date.now() + retryAfterMs) : undefined;
    return new LLMRateLimitError(
      e.message ?? 'rate limited / overloaded',
      resetAt,
      retryAfterMs,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
