import { describe, it, expect } from 'vitest';
import { __testing } from '../src/llm/subscription.js';

const { codingBuiltinsFor } = __testing;

describe('codingBuiltinsFor', () => {
  it('maps each canonical coding tool name to its SDK built-in', () => {
    expect(codingBuiltinsFor(['project_read_file'])).toEqual(['Read']);
    expect(codingBuiltinsFor(['project_list_dir'])).toEqual(['Glob']);
    expect(codingBuiltinsFor(['project_search'])).toEqual(['Grep']);
    expect(codingBuiltinsFor(['project_write_file'])).toEqual(['Write']);
    expect(codingBuiltinsFor(['project_edit_file'])).toEqual(['Edit']);
    expect(codingBuiltinsFor(['project_run_bash'])).toEqual(['Bash']);
  });

  it('ignores non-coding tool names', () => {
    expect(codingBuiltinsFor(['send_email', 'web_search'])).toEqual([]);
  });

  it('handles a mixed list, preserving only the coding tools', () => {
    expect(codingBuiltinsFor(['project_read_file', 'send_email', 'project_run_bash'])).toEqual(['Read', 'Bash']);
  });

  it('returns an empty array for an empty list', () => {
    expect(codingBuiltinsFor([])).toEqual([]);
  });
});
