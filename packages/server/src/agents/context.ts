import type { Agent, Server } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { LLMMessage, LLMContentBlock } from '../llm/types.js';
import type { AgentTrigger } from './dispatch.js';
import { getBrainIndex } from './brainIndex.js';
import { storage } from '../lib/storage.js';
import { isImageMime } from '../lib/extract.js';

const DOC_EXCERPT = 8000; // chars of an attachment's extracted text to include
const MAX_IMAGES = 4; // vision blocks per run (API-key mode)

const HISTORY_LIMIT = 20; // last N messages by count (not tokens)
const MSG_TRUNCATE = 800; // chars per message in history (the actual size cap)

export interface AssembledContext {
  system: string;
  messages: LLMMessage[];
  // Whether this is behind-the-scenes agent-to-agent traffic (terse protocol).
  agentToAgent: boolean;
}

/**
 * Assemble a run's context (see §4). Cheapest-first, never dumps the whole Brain:
 *   persona + role rules + compact Brain index + relevant private memories
 *   + capped channel history + the trigger.
 */
export async function assembleContext(
  agent: Agent,
  server: Server,
  trigger: AgentTrigger,
  // How much channel history to carry (see resolveRunProfile). 0 = none.
  historyLimit: number = HISTORY_LIMIT,
): Promise<AssembledContext> {
  const agentToAgent = trigger.trigger === 'agent';

  // These three reads are independent — fire them concurrently instead of
  // serially (one round-trip instead of three against the DB). The Brain index
  // is served from a versioned cache, so it usually skips the query entirely.
  const [brainIndex, memories, history, imageBlocks] = await Promise.all([
    getBrainIndex(server.id),
    // A few recent private memories (keys only, cheap).
    prisma.memory.findMany({
      where: { agentId: agent.id },
      select: { key: true },
      take: 15,
      orderBy: { updatedAt: 'desc' },
    }),
    // Capped channel/DM history transcript (multi-party, speaker-labeled).
    loadHistory(trigger, historyLimit),
    // Image attachments → vision blocks (API-key backend).
    loadImageBlocks(trigger),
  ]);

  const memoryIndex = memories.length ? memories.map((m) => `- ${m.key}`).join('\n') : '(none)';

  const personalityDirective = agentToAgent
    ? 'This is behind-the-scenes agent-to-agent traffic: be terse, structured, and token-minimal. No pleasantries.'
    : personalityLine(agent.personality);

  // The system prompt is the CACHED PREFIX: it sits in front of the tool
  // schemas and is re-read at ~0.1x instead of re-written at 1.25x, but only
  // while it stays byte-identical between runs.
  //
  // So nothing volatile may live here. The Brain index and memory keys used to,
  // and they change constantly — every proactive flag_important capture edited
  // the index, which invalidated this block AND the ~3k of tool schemas behind
  // it, forcing a full-price rewrite on the next run of every agent in the
  // workspace. They now ride in the message body instead (see `volatile`),
  // where changing is free.
  const system = [
    agent.systemPrompt.trim(),
    '',
    `You are "${agent.name}", an agent in the "${server.name}" project.`,
    server.description ? `Project context: ${server.description}` : '',
    agent.isManager
      // "For any complex, multi-step request" never fired: complexity is a
      // judgement the model resolves toward acting directly, so create_plan
      // always lost to ask_question or to just doing the work. Replaced with a
      // countable trigger it can actually evaluate, plus the explicit
      // don't-plan case so the rule doesn't over-fire on one-liners.
      ? 'You are the Manager: you may decompose tasks, assign work to other agents by @mentioning them or via create_task, collect results, and keep the Brain accurate. PLANNING: before starting work that needs three or more distinct steps, or that involves another agent, call create_plan first with a short goal and ordered steps — then execute them, calling update_plan_step to mark each running → done as you go. The plan is how the Commander watches progress, so create it before the work, not after. Do not plan work you can finish in one or two steps; just do it and reply.'
      : '',
    '',
    'TOOL & COLLABORATION RULES:',
    '- Pull only the Brain notes relevant to the task. Keep context minimal.',
    '- To hand off to another agent, @mention them in a message; respect the hop limit.',
    agentToAgent
      ? ''
      : '- PROACTIVE CAPTURE: call flag_important on your own — never asked — when you notice something still true next month: a decision, preference, deadline, key fact, or a pattern in HOW the Commander communicates (kind="style": recurring phrasing, tone, formatting habits, how blunt or warm they are). Judge it by one test: would an agent meeting them for the first time next month do better for knowing this? If not, skip it. At most one or two per conversation, and never restate something the Brain index already shows.',
    '- Your final text IS the chat message the Commander reads. Write it to them, never about them: no meta-narration ("the user mentioned me", "just a light acknowledgment", "I should reply briefly"). If nothing needs doing, say so in one short line — or say nothing at all rather than narrating.',
    '- Do not restate a message you already sent with send_channel_message; either use the tool or end with the text, not both.',
    // Without this the model meets tokens it was never told about, remarks on
    // them ("those look like placeholders, paste the real values"), and then
    // restoration swaps the real values INTO that confused sentence — turning a
    // working redaction into a nonsense reply. Observed in testing.
    (server.settings as { redactionEnabled?: boolean } | null)?.redactionEnabled
      ? '- PRIVACY PLACEHOLDERS: tokens like <EMAIL_1>, <DATA_3>, <PHONE_2> stand in for real values that are hidden from you and substituted back automatically after you reply. They are REAL data, not literal text or errors. Use them exactly as written — pass them to tools, quote them, reason about them — and never point them out, ask for "the actual values", or apologise for them. The Commander sees the real values in your reply.'
      : '',
    '- ' + personalityDirective,
  ]
    .filter(Boolean)
    .join('\n');

  const triggerText = triggerPrompt(trigger);

  // Split the turn into (stable history) + (new trigger) as separate content
  // blocks. The history block carries a cache breakpoint: it's the same prefix
  // across a run's tool loop and across back-to-back runs in a busy channel, so
  // it's re-read from cache at ~10% cost instead of re-billed each time. The
  // trigger changes every run and stays uncached. If there's no history yet, we
  // send the trigger alone (the provider caches the tail automatically).
  const blocks: LLMContentBlock[] = [];

  // Volatile context, evicted from the system prompt so that changing it costs
  // only itself rather than invalidating the system + tool-schema prefix.
  const volatile = [
    'SHARED BRAIN INDEX (titles + summaries only — use read_brain_note to pull full notes on demand; never assume content you have not read):',
    brainIndex,
    '',
    'YOUR PRIVATE MEMORY KEYS (use recall_memory to read):',
    memoryIndex,
  ].join('\n');
  blocks.push({ type: 'text', text: volatile });

  if (history) {
    blocks.push({ type: 'text', text: history, cache_control: { type: 'ephemeral' } });
  }
  // Vision blocks (if any) sit between the transcript and the trigger prompt.
  for (const img of imageBlocks) blocks.push(img);
  blocks.push({ type: 'text', text: triggerText });
  const messages: LLMMessage[] = [{ role: 'user', content: blocks }];

  return { system, messages, agentToAgent };
}

function personalityLine(p: number): string {
  if (p <= 20) return 'Tone: professional and concise.';
  if (p <= 60) return 'Tone: friendly and clear, with a light personal touch.';
  return 'Tone: warm and personable, with genuine personality — but still useful and on-task.';
}

async function loadHistory(trigger: AgentTrigger, limit = HISTORY_LIMIT): Promise<string> {
  if (limit <= 0) return ''; // self-contained run — see resolveRunProfile
  const where = trigger.dmThreadId
    ? { dmThreadId: trigger.dmThreadId }
    : trigger.channelId
      ? { channelId: trigger.channelId }
      : null;
  if (!where) return '';
  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      agent: { select: { name: true } },
      files: { select: { name: true, mimeType: true, extractedText: true } },
    },
  });
  if (rows.length === 0) return '';
  const lines = rows
    .reverse()
    .map((m) => {
      const who = m.senderType === 'AGENT' ? (m.agent?.name ?? 'Agent') : m.senderType === 'USER' ? 'User' : 'System';
      let line = `[${who}]: ${m.content.slice(0, MSG_TRUNCATE)}`;
      // Fold attachment content into the transcript so agents can read it.
      for (const f of m.files ?? []) {
        if (f.extractedText) {
          line += `\n  ↪ Attachment "${f.name}" (${f.mimeType}):\n${f.extractedText.slice(0, DOC_EXCERPT)}`;
        } else {
          line += `\n  ↪ Attachment "${f.name}" (${f.mimeType})${isImageMime(f.mimeType) ? ' — image' : ''}`;
        }
      }
      return line;
    });
  return `RECENT CONVERSATION:\n${lines.join('\n')}`;
}

// Load image attachments on the triggering message as vision blocks (API-key
// backend). Documents are already folded into the transcript as text.
async function loadImageBlocks(trigger: AgentTrigger): Promise<LLMContentBlock[]> {
  if (!trigger.triggeredByMessageId) return [];
  const files = await prisma.fileAsset.findMany({
    where: { messageId: trigger.triggeredByMessageId },
    select: { mimeType: true, storageKey: true },
  });
  const images = files.filter((f) => isImageMime(f.mimeType)).slice(0, MAX_IMAGES);
  const blocks: LLMContentBlock[] = [];
  for (const img of images) {
    try {
      const buf = await storage.get(img.storageKey);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: buf.toString('base64') } });
    } catch {
      // unreadable — skip
    }
  }
  return blocks;
}

function triggerPrompt(trigger: AgentTrigger): string {
  switch (trigger.trigger) {
    case 'task':
      return trigger.prompt ?? 'You have been assigned a task. Read it, do the work, and report results (update_task + post a summary).';
    case 'schedule':
      return `Scheduled job: ${trigger.prompt ?? 'run your scheduled report'}`;
    case 'hook':
      return `Automation triggered: ${trigger.prompt ?? 'respond to the hook event'}`;
    case 'agent':
      return trigger.prompt ?? 'Another agent handed off to you. Respond terse and structured.';
    case 'manual':
      return trigger.prompt ?? 'Respond.';
    case 'dm':
      return 'Respond to the latest direct message above.';
    case 'mention':
    default:
      return 'You were mentioned. Respond to the latest message directed at you.';
  }
}
