import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { __testing } from '../src/llm/subscription.js';

const { codingBuiltinsFor, fenceViolation } = __testing;

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

describe('fenceViolation', () => {
  const projectDir = path.join('C:', 'workspace', 'project');

  it('rejects an absolute file_path outside the project folder', () => {
    expect(fenceViolation('Write', { file_path: path.join('C:', 'tmp', 'verify.txt') }, projectDir)).toMatch(
      /outside the project folder/,
    );
  });

  it('rejects a ..-traversal path', () => {
    expect(fenceViolation('Read', { file_path: path.join('..', '..', 'secrets.txt') }, projectDir)).toMatch(
      /outside the project folder/,
    );
  });

  it('allows an absolute file_path inside the project folder', () => {
    expect(fenceViolation('Edit', { file_path: path.join(projectDir, 'src', 'index.ts') }, projectDir)).toBeNull();
  });

  it('allows a relative file_path resolving inside the project folder', () => {
    expect(fenceViolation('Read', { file_path: path.join('src', 'index.ts') }, projectDir)).toBeNull();
  });

  it('rejects Glob/Grep given a path escaping the project folder', () => {
    expect(fenceViolation('Glob', { pattern: '*.ts', path: path.join('C:', 'other') }, projectDir)).toMatch(
      /outside the project folder/,
    );
    expect(fenceViolation('Grep', { pattern: 'foo', path: path.join('C:', 'other') }, projectDir)).toMatch(
      /outside the project folder/,
    );
  });

  it('allows Glob/Grep with no path argument (defaults to cwd = projectDir)', () => {
    expect(fenceViolation('Glob', { pattern: '*.ts' }, projectDir)).toBeNull();
    expect(fenceViolation('Grep', { pattern: 'foo' }, projectDir)).toBeNull();
  });

  it('does not fence Bash — no path field, cwd is already pinned to projectDir', () => {
    expect(fenceViolation('Bash', { command: 'rm -rf /' }, projectDir)).toBeNull();
  });
});
