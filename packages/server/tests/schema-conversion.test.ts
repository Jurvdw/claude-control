import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { __testing } from '../src/llm/subscription.js';

// The SDK takes zod shapes, not JSON schema, so every tool's input_schema is
// converted. Flattening arrays to z.array(z.string()) silently dropped item
// schemas: create_workflow's steps arrived at the model as bare strings, the
// type enum never reached it, and workflows were built from defaults while the
// tool reported success. These guard the shape of that conversion.
const { jsonSchemaToZodShape } = __testing;

describe('jsonSchemaToZodShape', () => {
  it('preserves object items inside arrays', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: ['agent', 'post', 'brain'] }, text: { type: 'string' } },
            required: ['type'],
          },
        },
      },
      required: ['steps'],
    });
    const parsed = z.object(shape).parse({ steps: [{ type: 'post', text: 'hi' }] });
    expect(parsed.steps[0]).toEqual({ type: 'post', text: 'hi' });
  });

  it('rejects an item whose enum value is invalid', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['agent', 'post'] } }, required: ['type'] } },
      },
    });
    expect(() => z.object(shape).parse({ steps: [{ type: 'summarise' }] })).toThrow();
  });

  it('still handles plain string arrays', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { options: { type: 'array', items: { type: 'string' } } },
    });
    expect(z.object(shape).parse({ options: ['a', 'b'] }).options).toEqual(['a', 'b']);
  });

  it('keeps nested object properties instead of collapsing to a loose record', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { cfg: { type: 'object', properties: { cell: { type: 'string' }, value: { type: 'string' } } } },
    });
    expect(z.object(shape).parse({ cfg: { cell: 'B2', value: '7' } }).cfg).toEqual({ cell: 'B2', value: '7' });
  });
});
