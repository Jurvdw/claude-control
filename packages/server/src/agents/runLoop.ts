import type { Agent, Server, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { logger } from '../lib/logger.js';
import { getProviderForUser, estimateCost, LLMRateLimitError, LLMAuthError } from '../llm/index.js';
import type { LLMMessage, LLMContentBlock } from '../llm/types.js';
import { assembleContext } from './context.js';
import { resolveRunProfile } from './profile.js';
import { redact, restore, restoreDeep, type PrivacySettings } from '../lib/privacy.js';
import { enqueueAgentRun, type AgentTrigger } from './dispatch.js';
import { getTool, toolSpecsFor, toolCatalog } from '../tools/registry.js';
import { loadMcpServers } from '../lib/mcp.js';
import { getMcpToolSpecs, callMcpTool } from '../lib/mcpClient.js';
import type { LLMToolSpec } from '../llm/types.js';

const ITERATION_CAP = 8;
const DEFAULT_HOP_LIMIT = 4;

// Progressive tool disclosure (API-key / manual loop). These common tools are
// always sent with full schemas; everything else an agent has is advertised as
// a compact catalog and activated on demand via load_tools — so a request only
// carries the schemas the agent actually reaches for (schemas are the bulk of a
// prompt's tokens). Subscription mode keeps all tools (the SDK owns the loop).
const CORE_TOOLS = new Set(['send_channel_message', 'send_dm', 'read_brain_note', 'search_brain', 'flag_important', 'describe_self']);

// Tools that already put a chat-facing message in front of the Commander. If a
// run used one, the model's trailing text is redundant (usually narration about
// the reply it just sent) and is not posted a second time.
const POSTING_TOOLS = new Set(['send_channel_message', 'send_dm', 'ask_question', 'draft_email']);

// See needsApproval: these either put a decision in front of the Commander
// themselves or only read, so a blanket approval policy must not gate them.
const NEVER_GATED = new Set(['draft_email', 'ask_question', 'describe_self', 'request_capability', 'propose_self_improvement']);

const LOAD_TOOLS_SPEC: LLMToolSpec = {
  name: 'load_tools',
  description:
    'Activate one or more tools from the ADDITIONAL TOOLS catalog so you can call them. Pass their exact names. After activating, call the tool normally on your next step.',
  input_schema: {
    type: 'object',
    properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tool names to activate' } },
    required: ['names'],
  },
};

function setStatus(agent: Agent, status: string, thinkingLine = '') {
  bus.emit('agent.status', { serverId: agent.serverId, agentId: agent.id, status, thinkingLine });
  prisma.agent
    .update({ where: { id: agent.id }, data: { status: status as never, thinkingLine } })
    .catch(() => {});
}

/**
 * Execute one agent run. Called by the queue worker (and directly in tests).
 * With `opts.capture`, the run is "headless": the final text is returned instead
 * of posted to a channel and mention-chaining is skipped — used by the workflow
 * engine to feed one node's output into the next.
 */
export async function runAgent(trigger: AgentTrigger, opts?: { capture?: boolean }): Promise<string | void> {
  const agent = await prisma.agent.findUnique({ where: { id: trigger.agentId } });
  if (!agent || agent.serverId !== trigger.serverId) return;
  if (!agent.enabled || agent.status === 'PAUSED') return;

  const server = await prisma.server.findUnique({ where: { id: agent.serverId } });
  if (!server) return;

  const started = Date.now();
  const toolsUsed = new Set<string>();
  const run = await prisma.run.create({
    data: {
      serverId: server.id,
      agentId: agent.id,
      trigger: trigger.trigger,
      model: '',
      channelId: trigger.channelId ?? undefined,
      taskId: trigger.taskId ?? undefined,
      // In-flight until the run finishes (which sets 'ok'/'error'/'parked').
      // Creating it as 'ok' made a running row identical to a completed one:
      // Activity showed it as a success with 0 tokens, and a crash mid-run left
      // that lie behind permanently.
      status: 'running',
    },
  });

  setStatus(agent, 'THINKING', 'Assembling context…');

  try {
    const provider = await getProviderForUser(server.ownerId);
    const profile = resolveRunProfile(agent, trigger);
    const ctx = await assembleContext(agent, server, trigger, profile.historyLimit);
    const enabledTools = (agent.enabledTools as string[]) ?? [];
    const toolSpecs = toolSpecsFor(enabledTools);

    // Data safety net: swap known-sensitive values for placeholders before any
    // of this reaches the model. Restoration happens on the way back — on tool
    // inputs (executeToolForRun) and on the final reply.
    const privacy = (server.settings ?? {}) as PrivacySettings;
    await redactContext(server.id, ctx, privacy);
    const messages: LLMMessage[] = [...ctx.messages];

    let finalText = '';
    let totalCost = 0;
    const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let model = '';

    if (provider.ownsAgentLoop && provider.runAgentic) {
      // Subscription backend: the Agent SDK owns the loop. Hand it our tools
      // (bound to this run's context via executeToolForRun) + the prompt.
      setStatus(agent, 'WORKING', 'Thinking…');
      // The Agent SDK takes a single prompt string; flatten our content blocks
      // (history + trigger). Caching is a no-op in subscription mode anyway.
      const first = ctx.messages[0]?.content;
      const prompt =
        typeof first === 'string'
          ? first
          : Array.isArray(first)
            ? first.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n\n')
            : String(first ?? '');
      const mcpServers = await loadMcpServers(server.id);
      const result = await provider.runAgentic(
        {
          system: ctx.system,
          prompt,
          modelClass: profile.modelClass,
          effort: profile.effort,
          tools: toolSpecs,
          executeTool: (name, input) => {
            toolsUsed.add(name);
            return executeToolForRun(name, input, agent, server, run.id, trigger);
          },
          maxTurns: ITERATION_CAP,
          mcpServers,
        },
        (e) => {
          if (e.type === 'tool_use') { toolsUsed.add(e.name); setStatus(agent, 'WORKING', `Using ${e.name}…`); }
          else if (e.type === 'thinking_delta') setStatus(agent, 'THINKING', 'Reasoning…');
        },
      );
      model = result.model;
      usageTotals.inputTokens += result.usage.inputTokens;
      usageTotals.outputTokens += result.usage.outputTokens;
      usageTotals.cacheReadTokens += result.usage.cacheReadTokens;
      usageTotals.cacheWriteTokens += result.usage.cacheWriteTokens;
      totalCost += result.costUsdOverride ?? estimateCost(result.model, result.usage);
      finalText = result.text;
    } else {
    // External MCP tools (API-key mode routes them through our own MCP client).
    const mcpSpecs = await getMcpToolSpecs(server.id);
    // Progressive tool disclosure: core tools up front, the rest as a catalog.
    const deferred = enabledTools.filter((t) => !CORE_TOOLS.has(t) && getTool(t));
    const useDeferred = deferred.length > 2;
    let activeNames = useDeferred ? enabledTools.filter((t) => CORE_TOOLS.has(t)) : enabledTools;
    let loopTools = [...(useDeferred ? [...toolSpecsFor(activeNames), LOAD_TOOLS_SPEC] : toolSpecs), ...mcpSpecs];
    let systemPrompt = ctx.system;
    if (useDeferred) {
      const catalog = toolCatalog(deferred).map((t) => `- ${t.name}: ${t.brief}`).join('\n');
      systemPrompt +=
        `\n\nADDITIONAL TOOLS — you also have these, but their details aren't loaded yet. ` +
        `To use one, first call load_tools with its name(s), then call it on your next step (don't guess arguments before loading):\n${catalog}`;
    }

    for (let i = 0; i < ITERATION_CAP; i++) {
      setStatus(agent, 'WORKING', i === 0 ? 'Thinking…' : 'Continuing…');
      const result = await provider.run(
        {
          system: systemPrompt,
          messages,
          modelClass: profile.modelClass,
          effort: profile.effort,
          tools: loopTools,
          thinking: !ctx.agentToAgent, // terse (no thinking) for agent-to-agent
        },
        (e) => {
          if (e.type === 'tool_use') setStatus(agent, 'WORKING', `Using ${e.name}…`);
          else if (e.type === 'thinking_delta') setStatus(agent, 'THINKING', 'Reasoning…');
        },
      );

      model = result.model;
      usageTotals.inputTokens += result.usage.inputTokens;
      usageTotals.outputTokens += result.usage.outputTokens;
      usageTotals.cacheReadTokens += result.usage.cacheReadTokens;
      usageTotals.cacheWriteTokens += result.usage.cacheWriteTokens;
      totalCost += estimateCost(result.model, result.usage);
      if (result.text) finalText = result.text;

      // Server-side tools (web_search) run their own loop inside the model
      // call. When that loop hits its iteration cap the turn comes back with
      // stop_reason 'pause_turn' and NO tool_uses — breaking here would return
      // a half-finished answer. Echo the assistant turn back and let the
      // server resume where it left off (no extra user message: the API sees
      // the trailing server_tool_use and continues on its own).
      if (result.stopReason === 'pause_turn') {
        messages.push({ role: 'assistant', content: result.content });
        continue;
      }

      if (result.toolUses.length === 0) break;

      // Append the assistant turn, then execute tools → tool_result user turn.
      messages.push({ role: 'assistant', content: result.content });
      const toolResults: LLMContentBlock[] = [];
      for (const tu of result.toolUses) {
        // Meta-tool: activate deferred tools for subsequent steps.
        if (tu.name === 'load_tools') {
          const names = Array.isArray((tu.input as { names?: unknown }).names)
            ? ((tu.input as { names: unknown[] }).names.map(String))
            : [];
          const activated = names.filter((n) => deferred.includes(n) && !activeNames.includes(n));
          if (activated.length) {
            activeNames = [...activeNames, ...activated];
            loopTools = [...toolSpecsFor(activeNames), LOAD_TOOLS_SPEC, ...mcpSpecs];
          }
          const unknown = names.filter((n) => !deferred.includes(n));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content:
              (activated.length ? `Activated: ${activated.join(', ')}. Call them now.` : 'No new tools activated.') +
              (unknown.length ? ` Not in catalog: ${unknown.join(', ')}.` : ''),
          });
          continue;
        }
        toolsUsed.add(tu.name);
        // External MCP tool → route to the MCP client (no local registry entry).
        if (tu.name.startsWith('mcp__')) {
          // Same contract as our own tools: the external server gets real
          // values, and whatever it returns is redacted before the model sees it.
          const mcpInput = privacy.redactionEnabled
            ? ((await restoreDeep(server.id, tu.input)) as Record<string, unknown>)
            : (tu.input as Record<string, unknown>);
          const out = await callMcpTool(server.id, tu.name, mcpInput);
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: await redact(server.id, out, privacy) });
          continue;
        }
        const tool = getTool(tu.name);
        if (!tool) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool "${tu.name}".`, is_error: true });
          continue;
        }
        if (needsApproval(tool.name, tool.requiresApproval, agent, server)) {
          const summary = tool.summarize?.(tu.input) ?? `${tool.name}`;
          const approval = await prisma.approval.create({
            data: {
              serverId: server.id,
              agentId: agent.id,
              runId: run.id,
              action: tool.name,
              payload: { input: tu.input, channelId: trigger.channelId, taskId: trigger.taskId } as never,
              summary,
            },
          });
          bus.emit('approval.created', { serverId: server.id, approval });
          bus.emit('notification', {
            userId: server.ownerId,
            notification: { userId: server.ownerId, serverId: server.id, kind: 'approval', title: 'Approval needed', body: summary },
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Action queued for Commander approval (${summary}). Do not retry; continue with other work or wrap up.`,
          });
          continue;
        }
        try {
          const out = await tool.execute(tu.input, {
            serverId: server.id,
            agent,
            ownerUserId: server.ownerId,
            channelId: trigger.channelId,
            dmThreadId: trigger.dmThreadId,
            taskId: trigger.taskId,
            runId: run.id,
          });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${(err as Error).message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }
    } // end manual-loop branch

    // Post the agent's final text (chat-facing) if it produced any and didn't
    // already post via send_channel_message. Headless (capture) runs skip this.
    // Without the POSTING_TOOLS check the agent's trailing narration ("the user
    // mentioned me, just acknowledging") got posted as a second message on top
    // of the real reply it had already sent — noise, and billed tokens.
    // Put the real values back before anyone reads the reply — the Commander
    // must never see <EMAIL_2> where their customer's address belongs.
    if (privacy.redactionEnabled && finalText) finalText = await restore(server.id, finalText);

    const alreadyPosted = [...toolsUsed].some((t) => POSTING_TOOLS.has(t));
    if (finalText.trim() && !opts?.capture) {
      if (!alreadyPosted) await postFinalMessage(agent, trigger, finalText.trim());
      // Hand-offs still chain either way: an @mention in the trailing text must
      // reach the other agent even when we suppressed the text itself.
      await chainMentions(agent, server, trigger, finalText, run.id);
    }

    const finished = await prisma.run.update({
      where: { id: run.id },
      data: {
        model,
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        cacheReadTokens: usageTotals.cacheReadTokens,
        cacheWriteTokens: usageTotals.cacheWriteTokens,
        costUsd: totalCost,
        durationMs: Date.now() - started,
        status: 'ok',
        tools: [...toolsUsed],
      },
      include: { agent: { select: { name: true } } },
    });
    setStatus(agent, 'IDLE', '');
    bus.emit('run.finished', { serverId: server.id, run: { ...finished, agentName: finished.agent?.name ?? null } });
    if (opts?.capture) return finalText.trim();
  } catch (err) {
    // Headless runs surface errors to the workflow engine instead of posting.
    if (opts?.capture) {
      await prisma.run
        .update({ where: { id: run.id }, data: { status: 'error', error: (err as Error).message.slice(0, 1000) } })
        .catch(() => {});
      setStatus(agent, 'IDLE', '');
      throw err;
    }
    if (err instanceof LLMRateLimitError) {
      // Park + durable auto-resume: persist a ResumeJob the mechanical ticker
      // will re-enqueue at the reset time (survives restarts / multi-hour waits).
      await prisma.run.update({ where: { id: run.id }, data: { status: 'parked', error: err.message } });
      const attempt = (trigger.resumeAttempt ?? 0) + 1;
      const MAX_ATTEMPTS = 96; // ~48h of 30-min polling — a safety cap.
      if (attempt > MAX_ATTEMPTS) {
        await prisma.run.update({ where: { id: run.id }, data: { status: 'error', error: 'Gave up after repeated usage-limit waits.' } }).catch(() => {});
        setStatus(agent, 'IDLE', '');
        bus.emit('notification', {
          userId: server.ownerId,
          notification: { userId: server.ownerId, serverId: server.id, kind: 'error', title: `${agent.name} gave up waiting`, body: 'Usage limit did not clear after many auto-resume attempts.' },
        });
        return;
      }
      // Resume just after the reset (60s safety buffer), else poll in 30 min.
      const delayMs = err.resetAt
        ? Math.max(err.resetAt.getTime() - Date.now() + 60_000, 60_000)
        : (err.retryAfterMs ?? 30 * 60_000);
      const resumeAt = new Date(Date.now() + delayMs);
      await prisma.resumeJob.create({
        data: {
          serverId: server.id,
          agentId: agent.id,
          trigger: { ...trigger, resumeAttempt: attempt } as unknown as Prisma.InputJsonValue,
          resumeAt,
          reason: err.message.slice(0, 200),
          attempt,
        },
      });
      bus.emit('run.parked', { serverId: server.id, agentId: agent.id, runId: run.id, resetAt: resumeAt.toISOString() });
      const hhmm = resumeAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setStatus(agent, 'PAUSED', `⏳ usage limit — auto-resumes ~${hhmm}`);
      return;
    }
    const message = err instanceof LLMAuthError ? err.message : (err as Error).message;
    logger.error('agent run failed', { agentId: agent.id, error: message });
    // Never let error persistence cascade (e.g. odd characters in the message).
    await prisma.run
      .update({ where: { id: run.id }, data: { status: 'error', error: message.slice(0, 1000), tools: [...toolsUsed], durationMs: Date.now() - started } })
      .catch(() => {});
    bus.emit('run.finished', {
      serverId: server.id,
      run: { id: run.id, serverId: server.id, agentId: agent.id, agentName: agent.name, trigger: trigger.trigger, status: 'error', error: message.slice(0, 300), tools: [...toolsUsed], durationMs: Date.now() - started, createdAt: new Date() },
    });
    bus.emit('notification', {
      userId: server.ownerId,
      notification: { userId: server.ownerId, serverId: server.id, kind: 'error', title: `${agent.name} hit an error`, body: message },
    });
    // Make the failure visible in the conversation, so "no reply" is never silent.
    await postSystemError(agent, trigger, message).catch(() => {});
    setStatus(agent, 'ERROR', message.slice(0, 120));
  }
}

// Post a visible error in the channel/DM so a failed run isn't silent.
async function postSystemError(agent: Agent, trigger: AgentTrigger, reason: string) {
  if (!trigger.channelId && !trigger.dmThreadId) return;
  const message = await prisma.message.create({
    data: {
      serverId: agent.serverId,
      channelId: trigger.channelId ?? undefined,
      dmThreadId: trigger.dmThreadId ?? undefined,
      senderType: 'SYSTEM',
      content: `⚠️ **${agent.name}** couldn't respond: ${reason.slice(0, 400)}`,
    },
  });
  bus.emit('message.created', {
    serverId: agent.serverId,
    channelId: trigger.channelId,
    dmThreadId: trigger.dmThreadId,
    message,
  });
}

// Effective approval requirement: tool-level, agent-level, or server policy.
function needsApproval(
  toolName: string,
  toolRequires: boolean | undefined,
  agent: Agent,
  server: Server,
): boolean {
  if (toolRequires) return true;
  // Tools that ARE the review surface (or are read-only) are never gated by a
  // blanket agent/server policy — queueing an approval for draft_email would
  // hide the very card the Commander approves from, and stall the run.
  // An explicit per-tool requiresApproval (send_email) still wins above.
  if (NEVER_GATED.has(toolName)) return false;
  if (agent.requiresApproval) return true;
  const settings = (server.settings ?? {}) as { approvalMode?: boolean; approvalActions?: string[] };
  if (settings.approvalMode && settings.approvalActions?.includes(toolName)) return true;
  return false;
}

// Execute a registered tool for a run, applying the approval policy. Shared by
// the manual loop and the subscription (SDK-owned) loop.
/**
 * Redact a run's system prompt and message blocks in place. This is the single
 * outbound choke point — everything the model sees is assembled here, so a value
 * that survives this function is a value that reaches Anthropic.
 */
async function redactContext(
  serverId: string,
  ctx: { system: string; messages: LLMMessage[] },
  privacy: PrivacySettings,
): Promise<void> {
  if (!privacy.redactionEnabled) return;
  ctx.system = await redact(serverId, ctx.system, privacy);
  for (const m of ctx.messages) {
    if (typeof m.content === 'string') {
      m.content = await redact(serverId, m.content, privacy);
      continue;
    }
    for (const block of m.content as LLMContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        block.text = await redact(serverId, block.text, privacy);
      }
    }
  }
}

async function executeToolForRun(
  name: string,
  input: Record<string, unknown>,
  agent: Agent,
  server: Server,
  runId: string,
  trigger: AgentTrigger,
): Promise<string> {
  const tool = getTool(name);
  if (!tool) return `Unknown tool "${name}".`;

  // The model reasons over placeholders, but tools must act on reality: an
  // email to <EMAIL_2> has to be addressed to the actual mailbox. Restore first,
  // so approval summaries and execution both see the real values.
  const privacy = (server.settings ?? {}) as PrivacySettings;
  const realInput = privacy.redactionEnabled
    ? ((await restoreDeep(server.id, input)) as Record<string, unknown>)
    : input;

  if (needsApproval(tool.name, tool.requiresApproval, agent, server)) {
    const summary = tool.summarize?.(realInput) ?? tool.name;
    const approval = await prisma.approval.create({
      data: {
        serverId: server.id,
        agentId: agent.id,
        runId,
        action: tool.name,
        payload: { input: realInput, channelId: trigger.channelId, taskId: trigger.taskId } as never,
        summary,
      },
    });
    bus.emit('approval.created', { serverId: server.id, approval });
    bus.emit('notification', {
      userId: server.ownerId,
      notification: { userId: server.ownerId, serverId: server.id, kind: 'approval', title: 'Approval needed', body: summary },
    });
    return `Action queued for Commander approval (${summary}). Do not retry; continue or wrap up.`;
  }
  try {
    const out = await tool.execute(realInput, {
      serverId: server.id,
      agent,
      ownerUserId: server.ownerId,
      channelId: trigger.channelId,
      dmThreadId: trigger.dmThreadId,
      taskId: trigger.taskId,
      runId,
    });
    // The result goes straight back into the model's context, so it has to be
    // redacted again — a tool that reads the mailbox or the Brain will happily
    // hand back the very values we just stripped out.
    return await redact(server.id, out, privacy);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

async function postFinalMessage(agent: Agent, trigger: AgentTrigger, text: string) {
  if (!trigger.channelId && !trigger.dmThreadId) return;
  const message = await prisma.message.create({
    data: {
      serverId: agent.serverId,
      channelId: trigger.channelId ?? undefined,
      dmThreadId: trigger.dmThreadId ?? undefined,
      senderType: 'AGENT',
      agentId: agent.id,
      content: text,
    },
  });
  bus.emit('message.created', {
    serverId: agent.serverId,
    channelId: trigger.channelId,
    dmThreadId: trigger.dmThreadId,
    message,
  });
}

// Parse @mentions in the agent's output and enqueue chained runs (hop-limited).
async function chainMentions(agent: Agent, server: Server, trigger: AgentTrigger, text: string, _runId: string) {
  const settings = (server.settings ?? {}) as { hopLimit?: number };
  const hopLimit = settings.hopLimit ?? DEFAULT_HOP_LIMIT;
  const hops = (trigger.hops ?? 0) + 1;
  if (hops > hopLimit) return;
  if (!trigger.channelId) return; // chaining happens in channels

  const mentioned = new Set<string>();
  const everyone = /@everyone\b/i.test(text);
  const names = [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase());

  const agents = await prisma.agent.findMany({ where: { serverId: server.id, enabled: true } });
  for (const a of agents) {
    if (a.id === agent.id) continue; // don't self-trigger
    const handle = a.name.replace(/\s+/g, '').toLowerCase();
    if (everyone || names.includes(handle)) mentioned.add(a.id);
  }

  for (const agentId of mentioned) {
    await enqueueAgentRun({
      serverId: server.id,
      agentId,
      trigger: 'agent',
      channelId: trigger.channelId,
      hops,
      prompt: `${agent.name} mentioned you. Latest message:\n${text.slice(0, 1000)}`,
    });
  }
}

