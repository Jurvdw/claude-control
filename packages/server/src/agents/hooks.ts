import { prisma } from '../lib/prisma.js';
import { enqueueAgentRun } from './dispatch.js';

// Proactive triggers: fire agent runs when a message matches a keyword hook, or
// when files are attached (new_file hook). Only invoked for USER messages (the
// send route), so agents posting can't recursively re-trigger hooks.

function render(template: string, message: string): string {
  return template.replace(/\{\{\s*message\s*\}\}/gi, message);
}

export async function fireKeywordHooks(
  serverId: string,
  channelId: string,
  content: string,
  messageId: string,
): Promise<void> {
  const hooks = await prisma.hook.findMany({ where: { serverId, trigger: 'keyword', enabled: true } });
  if (hooks.length === 0) return;
  const lower = content.toLowerCase();
  for (const h of hooks) {
    if (h.channelId && h.channelId !== channelId) continue; // channel-scoped
    const cfg = (h.config ?? {}) as { keyword?: string };
    const kw = (cfg.keyword ?? '').toLowerCase().trim();
    if (!kw || !lower.includes(kw)) continue;
    await enqueueAgentRun({
      serverId,
      agentId: h.agentId,
      trigger: 'hook',
      channelId,
      prompt: render(h.promptTemplate, content),
      triggeredByMessageId: messageId,
      hops: 0,
    });
  }
}

export async function fireFileHooks(
  serverId: string,
  channelId: string,
  fileNames: string[],
  messageId: string,
): Promise<void> {
  if (fileNames.length === 0) return;
  const hooks = await prisma.hook.findMany({ where: { serverId, trigger: 'new_file', enabled: true } });
  for (const h of hooks) {
    if (h.channelId && h.channelId !== channelId) continue;
    await enqueueAgentRun({
      serverId,
      agentId: h.agentId,
      trigger: 'hook',
      channelId,
      prompt: `${h.promptTemplate}\n\nAttached file(s): ${fileNames.join(', ')}`,
      triggeredByMessageId: messageId,
      hops: 0,
    });
  }
}
