import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prisma } from '../lib/prisma.js';
import { registerTool, type ToolContext } from './registry.js';

const MAX_READ_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 20_000;
const BASH_TIMEOUT_MS = 120_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_LIST_ENTRIES = 500;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);

const NO_PROJECT_DIR =
  'No project folder set for this workspace — set one in workspace settings before using coding tools.';

async function projectDirFor(ctx: ToolContext): Promise<string | null> {
  const server = await prisma.server.findUnique({ where: { id: ctx.serverId }, select: { settings: true } });
  const dir = (server?.settings as { projectDir?: string } | null)?.projectDir;
  return dir && dir.trim() ? dir : null;
}

// Resolve a tool-supplied relative path against the project folder, rejecting
// any path that would escape it (..-traversal or an absolute path elsewhere).
// Also used by llm/subscription.ts to fence the SDK's built-in Read/Write/
// Edit/Glob/Grep tools the same way.
export function resolveInProject(projectDir: string, relPath: string): string | null {
  const resolved = path.resolve(projectDir, relPath);
  const rel = path.relative(projectDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

registerTool({
  name: 'project_read_file',
  description: "Read a file's text content from the workspace's project folder. Path is relative to the project root.",
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path, relative to the project folder' } },
    required: ['path'],
  },
  summarize: (input) => `Read ${input.path}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const target = resolveInProject(projectDir, String(input.path));
    if (!target) return `"${input.path}" is outside the project folder.`;
    try {
      const content = await fs.readFile(target, 'utf8');
      return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n… (truncated, ${content.length} chars total)`
        : content;
    } catch (err) {
      return `Could not read "${input.path}": ${(err as Error).message}`;
    }
  },
});

registerTool({
  name: 'project_list_dir',
  description:
    'List files and folders under a path in the workspace\'s project folder (recursive). Optional "filter" narrows to names containing that substring.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list, relative to the project folder. Defaults to the root.' },
      filter: { type: 'string', description: 'Only include entries whose name contains this substring (case-insensitive).' },
    },
  },
  summarize: (input) => `List ${input.path || '.'}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const start = resolveInProject(projectDir, String(input.path ?? '.'));
    if (!start) return `"${input.path}" is outside the project folder.`;
    const filter = input.filter ? String(input.filter).toLowerCase() : undefined;
    const out: string[] = [];

    async function walk(dir: string) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_LIST_ENTRIES) return;
        if (IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        // Normalize to forward slashes — path.relative uses the OS separator
        // (backslash on Windows), which would otherwise mix with the literal
        // "/" suffix below and read inconsistently.
        const rel = path.relative(projectDir!, full).split(path.sep).join('/');
        if (!filter || e.name.toLowerCase().includes(filter)) out.push(e.isDirectory() ? `${rel}/` : rel);
        if (e.isDirectory()) await walk(full);
      }
    }
    await walk(start);
    if (out.length === 0) return '(empty)';
    return out.join('\n') + (out.length >= MAX_LIST_ENTRIES ? `\n… (truncated at ${MAX_LIST_ENTRIES} entries)` : '');
  },
});

registerTool({
  name: 'project_search',
  description:
    'Search file contents in the workspace\'s project folder for a substring, like grep. Returns matching "path:line: text" entries.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for (case-insensitive substring match)' },
      path: { type: 'string', description: 'Directory to search under, relative to the project folder. Defaults to the root.' },
    },
    required: ['query'],
  },
  summarize: (input) => `Search for "${input.query}"`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const start = resolveInProject(projectDir, String(input.path ?? '.'));
    if (!start) return `"${input.path}" is outside the project folder.`;
    const query = String(input.query).toLowerCase();
    const matches: string[] = [];

    async function walk(dir: string) {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        if (IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
          continue;
        }
        let text: string;
        try {
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue; // binary or unreadable — skip
        }
        const rel = path.relative(projectDir!, full).split(path.sep).join('/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          if (lines[i].toLowerCase().includes(query)) matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    await walk(start);
    if (matches.length === 0) return 'No matches.';
    return matches.join('\n') + (matches.length >= MAX_SEARCH_MATCHES ? `\n… (truncated at ${MAX_SEARCH_MATCHES} matches)` : '');
  },
});

registerTool({
  name: 'project_write_file',
  description: "Create or overwrite a file in the workspace's project folder. Path is relative to the project root.",
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project folder' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  summarize: (input) => `Write ${input.path}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const target = resolveInProject(projectDir, String(input.path));
    if (!target) return `"${input.path}" is outside the project folder.`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(input.content), 'utf8');
      return `Wrote ${Buffer.byteLength(String(input.content), 'utf8')} bytes to ${input.path}.`;
    } catch (err) {
      return `Could not write "${input.path}": ${(err as Error).message}`;
    }
  },
});

registerTool({
  name: 'project_edit_file',
  description:
    'Replace an exact block of text in a file within the workspace\'s project folder. oldText must match exactly once; use project_read_file first to get exact text.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project folder' },
      oldText: { type: 'string', description: 'Exact text to replace — must occur exactly once in the file' },
      newText: { type: 'string' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  summarize: (input) => `Edit ${input.path}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const target = resolveInProject(projectDir, String(input.path));
    if (!target) return `"${input.path}" is outside the project folder.`;
    let content: string;
    try {
      content = await fs.readFile(target, 'utf8');
    } catch (err) {
      return `Could not read "${input.path}": ${(err as Error).message}`;
    }
    const oldText = String(input.oldText);
    const first = content.indexOf(oldText);
    if (first === -1) return `oldText not found in "${input.path}" — read the file first to get exact text.`;
    const second = content.indexOf(oldText, first + oldText.length);
    if (second !== -1) return `oldText matches more than once in "${input.path}" — include more surrounding context to make it unique.`;
    const updated = content.slice(0, first) + String(input.newText) + content.slice(first + oldText.length);
    await fs.writeFile(target, updated, 'utf8');
    return `Edited "${input.path}".`;
  },
});

registerTool({
  name: 'project_run_bash',
  description: "Run a shell command in the workspace's project folder and return its output.",
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  summarize: (input) => `Run: ${String(input.command).slice(0, 60)}…`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const command = String(input.command);
    return new Promise<string>((resolve) => {
      const child = spawn(command, { shell: true, cwd: projectDir });
      let out = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, BASH_TIMEOUT_MS);
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { out += d.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const capped = out.length > MAX_OUTPUT_CHARS ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : out;
        if (timedOut) resolve(`${capped}\n(command timed out after ${BASH_TIMEOUT_MS / 1000}s and was killed)`);
        else resolve(`${capped}\n(exit code ${code})`);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(`Failed to run command: ${err.message}`);
      });
    });
  },
});
