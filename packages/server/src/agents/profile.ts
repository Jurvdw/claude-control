import type { Agent, AgentModelClass, AgentEffort } from '@prisma/client';
import type { AgentTrigger } from './dispatch.js';

/**
 * Per-run profile: which model, how hard it thinks, and how much context it
 * carries. Resolved fresh for every run.
 *
 * The routing signal is STRUCTURAL, not semantic. We don't try to guess whether
 * a question "looks easy" — that needs a classifier call (which costs the very
 * tokens we're saving) and misroutes exactly when it matters. Instead we route
 * on how the run was created, which is known for free and always true:
 *
 *  - An agent-to-agent delegation carries its whole task in the prompt. The
 *    delegating agent already read the conversation and decided what to ask, so
 *    replaying the channel history to the delegate is pure duplication.
 *  - A schedule/webhook run has no conversation to be part of. Its prompt is
 *    self-contained by construction.
 *  - A mention or DM is the opposite: the user is mid-conversation and every
 *    "it", "that one", "do it again" refers to something in the history.
 *
 * So delegated + automated work runs lean; conversational work keeps its
 * context. An agent's configured model is a CEILING, never raised here — a
 * Haiku agent is never silently promoted to Opus.
 */

export interface RunProfile {
  modelClass: AgentModelClass;
  effort: AgentEffort;
  /** Messages of channel/DM history to include. 0 = none (self-contained run). */
  historyLimit: number;
  /** Why this profile was chosen (surfaced in logs/activity for debugging). */
  reason: string;
}

const RANK: Record<AgentModelClass, number> = { HAIKU: 0, SONNET: 1, OPUS: 2 };

/** Never exceed the agent's configured model; step down freely. */
function cap(agent: Agent, want: AgentModelClass): AgentModelClass {
  return RANK[want] <= RANK[agent.modelClass] ? want : agent.modelClass;
}

const DEFAULT_HISTORY = 20;

export function resolveRunProfile(agent: Agent, trigger: AgentTrigger): RunProfile {
  // Agent-to-agent: the delegation prompt is the full brief. Cheapest sensible
  // model, no history, low effort — this is the single biggest saving, because
  // delegated runs are the ones that multiply.
  if (trigger.trigger === 'agent') {
    return {
      modelClass: cap(agent, 'SONNET'),
      effort: 'LOW',
      historyLimit: 0,
      reason: 'delegated subtask (self-contained prompt)',
    };
  }

  // Scheduled / webhook work: no conversation to miss, but it may be a big job,
  // so keep the agent's own model and effort. Just don't ship a transcript.
  if (trigger.trigger === 'schedule' || trigger.trigger === 'hook') {
    return {
      modelClass: agent.modelClass,
      effort: agent.effort,
      historyLimit: 0,
      reason: 'automated run (no conversation context)',
    };
  }

  // A task assignment names its own work; a little history helps it place the
  // task in context without replaying the whole channel.
  if (trigger.trigger === 'task') {
    return {
      modelClass: agent.modelClass,
      effort: agent.effort,
      historyLimit: 5,
      reason: 'task run (short context)',
    };
  }

  // Conversational (mention / dm / manual): full context, agent's own settings.
  return {
    modelClass: agent.modelClass,
    effort: agent.effort,
    historyLimit: DEFAULT_HISTORY,
    reason: 'conversational',
  };
}
