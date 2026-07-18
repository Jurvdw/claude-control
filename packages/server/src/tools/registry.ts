import type { Agent } from '@prisma/client';
import type { LLMToolSpec } from '../llm/types.js';

// Execution context handed to every tool. Carries tenant scope + the acting
// agent + where output should land.
export interface ToolContext {
  serverId: string;
  agent: Agent;
  // The account whose Anthropic key / storage the run bills against
  // (the server owner). Used for provider resolution and notifications.
  ownerUserId: string;
  channelId?: string | null;
  dmThreadId?: string | null;
  taskId?: string | null;
  runId?: string | null;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  // Whether the action needs Commander approval before executing. Combined with
  // the agent/server approval policy in the run loop.
  requiresApproval?: boolean;
  // Human summary of a pending call, shown on approval cards / thinking bubbles.
  summarize?: (input: Record<string, unknown>) => string;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function allTools(): Tool[] {
  return [...registry.values()];
}

/** Build the LLM tool specs for a given set of enabled tool names (deduped). */
export function toolSpecsFor(names: string[]): LLMToolSpec[] {
  const seen = new Set<string>();
  const specs: LLMToolSpec[] = [];
  for (const n of names) {
    if (seen.has(n)) continue; // an agent may have the same tool listed twice
    seen.add(n);
    const t = registry.get(n);
    if (t) specs.push({ name: t.name, description: t.description, input_schema: t.input_schema });
  }
  return specs;
}

/** A compact catalog (name + one-line brief) for progressive tool disclosure —
 *  advertises tools cheaply without sending their full JSON schemas. */
export function toolCatalog(names: string[]): { name: string; brief: string }[] {
  const seen = new Set<string>();
  const out: { name: string; brief: string }[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    const t = registry.get(n);
    if (!t) continue;
    const brief = (t.description.split(/(?<=[.!?])\s/)[0] ?? t.description).slice(0, 120);
    out.push({ name: t.name, brief });
  }
  return out;
}
