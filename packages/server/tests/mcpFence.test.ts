import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMcpPaths } from '../src/lib/mcpFence.js';

const serverRoot = path.resolve(fileURLToPath(import.meta.url), '../..'); // packages/server

describe('checkMcpPaths', () => {
  it('allows an unrelated folder', () => {
    expect(checkMcpPaths({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', path.join('C:', 'Users', 'someone', 'Documents')] })).toBeNull();
  });

  it('blocks the app source directory', () => {
    expect(checkMcpPaths({ command: 'npx', args: ['-y', 'fs', serverRoot] })).toMatch(/Claude Control/);
  });

  it('blocks a nested path inside the app', () => {
    expect(checkMcpPaths({ command: 'npx', args: [path.join(serverRoot, 'src', 'tools')] })).toMatch(/Claude Control/);
  });

  it('blocks an ancestor of the app (a broad root)', () => {
    expect(checkMcpPaths({ command: 'npx', args: [path.parse(serverRoot).root] })).toMatch(/Claude Control/);
  });

  it('blocks a protected path smuggled through env', () => {
    expect(checkMcpPaths({ command: 'npx', args: [], env: { ROOT_DIR: serverRoot } })).toMatch(/Claude Control/);
  });

  it('ignores flags and package specs', () => {
    expect(checkMcpPaths({ command: 'npx', args: ['-y', '--verbose', 'server-github'], env: { GITHUB_TOKEN: 'ghp_x' } })).toBeNull();
  });
});
