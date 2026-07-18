// Trigger contract + pluggable dispatcher. The run loop and services enqueue
// agent runs through here; the queue module (BullMQ) registers the real
// dispatcher at boot. This avoids a circular dependency between the run loop
// and the queue, and lets tests inject a synchronous dispatcher.

export type TriggerKind = 'mention' | 'dm' | 'task' | 'schedule' | 'hook' | 'agent' | 'manual';

export interface AgentTrigger {
  serverId: string;
  agentId: string;
  trigger: TriggerKind;
  channelId?: string | null;
  dmThreadId?: string | null;
  taskId?: string | null;
  // Freeform prompt for schedule/hook/manual triggers.
  prompt?: string;
  // Mention-chaining hop count (default 0). Enforced against the server hop limit.
  hops?: number;
  triggeredByMessageId?: string;
  // How many times this run has been auto-resumed after a usage-limit park.
  resumeAttempt?: number;
}

type Dispatcher = (t: AgentTrigger) => Promise<void>;

let dispatcher: Dispatcher | null = null;

export function setDispatcher(d: Dispatcher): void {
  dispatcher = d;
}

export async function enqueueAgentRun(t: AgentTrigger): Promise<void> {
  if (!dispatcher) {
    // No queue wired (e.g. tests). Silently drop — callers shouldn't crash.
    return;
  }
  await dispatcher(t);
}
