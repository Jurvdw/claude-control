import { describe, it, expect } from 'vitest';
import {
  MODEL_IDS,
  EFFORT_MAP,
  PRICES,
  estimateCost,
  type TokenUsage,
} from '../src/llm/pricing.js';
import type { AgentModelClass, AgentEffort } from '@prisma/client';

describe('pricing module', () => {
  describe('MODEL_IDS', () => {
    it('should map HAIKU to claude-haiku-4-5', () => {
      expect(MODEL_IDS.HAIKU).toBe('claude-haiku-4-5');
    });

    it('should map SONNET to claude-sonnet-4-6', () => {
      expect(MODEL_IDS.SONNET).toBe('claude-sonnet-4-6');
    });

    it('should map OPUS to claude-opus-4-8', () => {
      expect(MODEL_IDS.OPUS).toBe('claude-opus-4-8');
    });

    it('should have all three model classes', () => {
      const classes: AgentModelClass[] = ['HAIKU', 'SONNET', 'OPUS'];
      for (const cls of classes) {
        expect(MODEL_IDS[cls]).toBeDefined();
        expect(typeof MODEL_IDS[cls]).toBe('string');
      }
    });
  });

  describe('EFFORT_MAP', () => {
    it('should have LOW effort level', () => {
      expect(EFFORT_MAP.LOW).toBeDefined();
      expect(EFFORT_MAP.LOW.effort).toBe('low');
      expect(EFFORT_MAP.LOW.maxTokens).toBe(4096);
    });

    it('should have MEDIUM effort level', () => {
      expect(EFFORT_MAP.MEDIUM).toBeDefined();
      expect(EFFORT_MAP.MEDIUM.effort).toBe('medium');
      expect(EFFORT_MAP.MEDIUM.maxTokens).toBe(8192);
    });

    it('should have HIGH effort level', () => {
      expect(EFFORT_MAP.HIGH).toBeDefined();
      expect(EFFORT_MAP.HIGH.effort).toBe('high');
      expect(EFFORT_MAP.HIGH.maxTokens).toBe(16000);
    });

    it('should have all three effort levels', () => {
      const efforts: AgentEffort[] = ['LOW', 'MEDIUM', 'HIGH'];
      for (const effort of efforts) {
        expect(EFFORT_MAP[effort]).toBeDefined();
        expect(EFFORT_MAP[effort].effort).toMatch(/^(low|medium|high)$/);
        expect(EFFORT_MAP[effort].maxTokens).toBeGreaterThan(0);
      }
    });
  });

  describe('PRICES', () => {
    it('should have pricing for claude-haiku-4-5', () => {
      const price = PRICES['claude-haiku-4-5'];
      expect(price).toBeDefined();
      expect(price.input).toBe(1);
      expect(price.output).toBe(5);
      expect(price.cacheRead).toBe(0.1);
      expect(price.cacheWrite).toBe(1.25);
    });

    it('should have pricing for claude-sonnet-4-6', () => {
      const price = PRICES['claude-sonnet-4-6'];
      expect(price).toBeDefined();
      expect(price.input).toBe(3);
      expect(price.output).toBe(15);
      expect(price.cacheRead).toBe(0.3);
      expect(price.cacheWrite).toBe(3.75);
    });

    it('should have pricing for claude-opus-4-8', () => {
      const price = PRICES['claude-opus-4-8'];
      expect(price).toBeDefined();
      expect(price.input).toBe(5);
      expect(price.output).toBe(25);
      expect(price.cacheRead).toBe(0.5);
      expect(price.cacheWrite).toBe(6.25);
    });

    it('all prices should have positive input and output', () => {
      for (const [model, price] of Object.entries(PRICES)) {
        expect(price.input).toBeGreaterThan(0);
        expect(price.output).toBeGreaterThan(0);
        expect(price.cacheRead).toBeGreaterThan(0);
        expect(price.cacheWrite).toBeGreaterThan(0);
      }
    });
  });

  describe('estimateCost', () => {
    it('should calculate cost for haiku', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const cost = estimateCost('claude-haiku-4-5', usage);
      // (1000 * 1 + 500 * 5) / 1_000_000 = 3500 / 1_000_000 = 0.0035
      expect(cost).toBeCloseTo(0.0035, 6);
    });

    it('should calculate cost for sonnet', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const cost = estimateCost('claude-sonnet-4-6', usage);
      // (1000 * 3 + 500 * 15) / 1_000_000 = 10500 / 1_000_000 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('should calculate cost for opus', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const cost = estimateCost('claude-opus-4-8', usage);
      // (1000 * 5 + 500 * 25) / 1_000_000 = 17500 / 1_000_000 = 0.0175
      expect(cost).toBeCloseTo(0.0175, 6);
    });

    it('should include cache read tokens', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 10000,
        cacheWriteTokens: 0,
      };
      const cost = estimateCost('claude-sonnet-4-6', usage);
      // (10000 * 0.3) / 1_000_000 = 3000 / 1_000_000 = 0.003
      expect(cost).toBeCloseTo(0.003, 6);
    });

    it('should include cache write tokens', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 10000,
      };
      const cost = estimateCost('claude-sonnet-4-6', usage);
      // (10000 * 3.75) / 1_000_000 = 37500 / 1_000_000 = 0.0375
      expect(cost).toBeCloseTo(0.0375, 6);
    });

    it('should handle mixed token usage', () => {
      const usage: TokenUsage = {
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        cacheWriteTokens: 1000,
      };
      const cost = estimateCost('claude-sonnet-4-6', usage);
      // (5000*3 + 2000*15 + 3000*0.3 + 1000*3.75) / 1_000_000
      // = (15000 + 30000 + 900 + 3750) / 1_000_000 = 49650 / 1_000_000
      expect(cost).toBeCloseTo(0.04965, 6);
    });

    it('should return 0 for unknown model', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const cost = estimateCost('unknown-model', usage);
      expect(cost).toBe(0);
    });

    it('should handle zero tokens', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const cost = estimateCost('claude-sonnet-4-6', usage);
      expect(cost).toBe(0);
    });
  });
});
