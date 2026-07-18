import { describe, it, expect } from 'vitest';
import type { Agent } from '@prisma/client';
import { resolveRunProfile } from '../src/agents/profile.js';
import type { AgentTrigger } from '../src/agents/dispatch.js';

const agent = (modelClass: 'HAIKU' | 'SONNET' | 'OPUS', effort: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH') =>
  ({ id: 'a1', serverId: 's1', modelClass, effort } as unknown as Agent);

const trig = (trigger: AgentTrigger['trigger']): AgentTrigger =>
  ({ serverId: 's1', agentId: 'a1', trigger });

describe('resolveRunProfile', () => {
  it('drops history and steps down the model for delegated subtasks', () => {
    const p = resolveRunProfile(agent('OPUS'), trig('agent'));
    expect(p.historyLimit).toBe(0);
    expect(p.modelClass).toBe('SONNET');
    expect(p.effort).toBe('LOW');
  });

  it('never promotes an agent above its configured model', () => {
    // A Haiku agent delegated to stays Haiku — the cap is one-directional.
    expect(resolveRunProfile(agent('HAIKU'), trig('agent')).modelClass).toBe('HAIKU');
  });

  it('drops history for automated runs but keeps the agent\'s own model', () => {
    for (const t of ['schedule', 'hook'] as const) {
      const p = resolveRunProfile(agent('OPUS'), trig(t));
      expect(p.historyLimit).toBe(0);
      expect(p.modelClass).toBe('OPUS');
      expect(p.effort).toBe('HIGH');
    }
  });

  it('gives task runs a short context', () => {
    expect(resolveRunProfile(agent('SONNET'), trig('task')).historyLimit).toBe(5);
  });

  it('keeps full context and settings for conversation', () => {
    for (const t of ['mention', 'dm', 'manual'] as const) {
      const p = resolveRunProfile(agent('OPUS'), trig(t));
      expect(p.historyLimit).toBe(20);
      expect(p.modelClass).toBe('OPUS');
      expect(p.effort).toBe('HIGH');
    }
  });
});
