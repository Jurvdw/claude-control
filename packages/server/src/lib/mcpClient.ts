// A real MCP client for the API-key (manual-loop) provider path — connects to
// configured MCP servers, lists their tools, and routes tool calls. (Subscription
// mode uses the Agent SDK's native MCP instead; see lib/mcp.ts.)
//
// Connections are cached for the process lifetime and reconnected on error.

import { createRequire } from 'node:module';
import type { McpServer } from '@prisma/client';
import type { LLMToolSpec } from '../llm/types.js';
import { prisma } from './prisma.js';
import { decrypt } from './crypto.js';
import { logger } from './logger.js';
import { checkMcpPaths } from './mcpFence.js';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as { Client: new (info: any, opts: any) => McpClient };
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js') as { StdioClientTransport: new (o: any) => unknown };
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as { StreamableHTTPClientTransport: new (u: URL, o?: any) => unknown };
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js') as { SSEClientTransport: new (u: URL, o?: any) => unknown };
/* eslint-enable @typescript-eslint/no-explicit-any */

interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
interface McpClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{ content?: { type: string; text?: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}

function secretsOf(row: McpServer): { env?: Record<string, string>; headers?: Record<string, string> } {
  if (!row.secretsEnc) return {};
  try { return JSON.parse(decrypt(row.secretsEnc)); } catch { return {}; }
}

function makeTransport(row: McpServer): unknown | null {
  const s = secretsOf(row);
  if (row.transport === 'stdio') {
    if (!row.command) return null;
    const args = Array.isArray(row.args) ? (row.args as string[]) : [];
    // Safety fence — never spawn a server aimed at Claude Control's own files.
    if (checkMcpPaths({ command: row.command, args, env: s.env })) return null;
    return new StdioClientTransport({ command: row.command, args, env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) } });
  }
  if (row.transport === 'http') {
    if (!row.url) return null;
    return new StreamableHTTPClientTransport(new URL(row.url), s.headers ? { requestInit: { headers: s.headers } } : undefined);
  }
  if (row.transport === 'sse') {
    if (!row.url) return null;
    return new SSEClientTransport(new URL(row.url), s.headers ? { requestInit: { headers: s.headers } } : undefined);
  }
  return null;
}

interface Conn { client: McpClient; specs: LLMToolSpec[]; toolByFullName: Map<string, string>; updatedAt: number }
const conns = new Map<string, Conn>(); // key: row.id

async function connect(row: McpServer): Promise<Conn | null> {
  const transport = makeTransport(row);
  if (!transport) return null;
  const client = new Client({ name: 'claude-control', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const specs: LLMToolSpec[] = tools.map((t) => ({
    name: `mcp__${row.name}__${t.name}`,
    description: (t.description ?? t.name).slice(0, 500),
    input_schema: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} },
  }));
  const toolByFullName = new Map(tools.map((t) => [`mcp__${row.name}__${t.name}`, t.name]));
  return { client, specs, toolByFullName, updatedAt: row.updatedAt.getTime() };
}

async function ensure(row: McpServer): Promise<Conn | null> {
  const cached = conns.get(row.id);
  if (cached && cached.updatedAt === row.updatedAt.getTime()) return cached;
  if (cached) { await cached.client.close().catch(() => {}); conns.delete(row.id); }
  try {
    const conn = await connect(row);
    if (conn) conns.set(row.id, conn);
    return conn;
  } catch (err) {
    logger.warn('MCP connect failed', { name: row.name, error: friendly(err) });
    return null;
  }
}

// Tool specs from all enabled MCP servers for a workspace (API-key mode).
export async function getMcpToolSpecs(serverId: string): Promise<LLMToolSpec[]> {
  const rows = await prisma.mcpServer.findMany({ where: { serverId, enabled: true } });
  const out: LLMToolSpec[] = [];
  for (const row of rows) {
    const conn = await ensure(row);
    if (conn) out.push(...conn.specs);
  }
  return out;
}

// Execute an mcp__<name>__<tool> call, reconnecting once on a stale connection.
export async function callMcpTool(serverId: string, fullName: string, input: Record<string, unknown>): Promise<string> {
  const rows = await prisma.mcpServer.findMany({ where: { serverId, enabled: true } });
  const row = rows.find((r) => fullName.startsWith(`mcp__${r.name}__`));
  if (!row) return `No MCP server provides "${fullName}".`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = await ensure(row);
    if (!conn) return `MCP server "${row.name}" is unavailable.`;
    const toolName = conn.toolByFullName.get(fullName);
    if (!toolName) return `MCP server "${row.name}" has no tool "${fullName}".`;
    try {
      const res = await conn.client.callTool({ name: toolName, arguments: input });
      const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n').trim();
      return (res.isError ? 'Tool error: ' : '') + (text || '(no output)');
    } catch (err) {
      conns.delete(row.id); // force reconnect on retry
      if (attempt === 1) return `MCP call failed: ${friendly(err)}`;
    }
  }
  return 'MCP call failed.';
}

// Connect to one server, list its tools, and disconnect — for the "test" button.
export async function testMcpServer(row: McpServer): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  const transport = makeTransport(row);
  if (!transport) return { ok: false, error: 'Incomplete configuration.' };
  const client = new Client({ name: 'claude-control', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close().catch(() => {});
    return { ok: true, tools: tools.map((t) => t.name) };
  } catch (err) {
    await client.close().catch(() => {});
    return { ok: false, error: friendly(err) };
  }
}

// Turn spawn/connection errors into something a non-technical user can act on.
function friendly(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/ENOENT|spawn.*not found|not recognized/i.test(msg)) {
    return "Command not found on this machine. If it's an npx/node server, install Node.js (nodejs.org); for uvx/python, install Python.";
  }
  // A stdio server that dies immediately reports a closed connection — usually a
  // missing command, a wrong package name, or a bad token the server rejects.
  if (/Connection closed|-32000|exited|ECONNRESET/i.test(msg)) {
    return "The server didn't start. Check the command is installed (Node.js from nodejs.org for npx servers), the package name is correct, and any required token/keys are valid.";
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|timed? ?out|401|403/i.test(msg)) return `Couldn't reach or authenticate to the server: ${msg}`;
  return msg.slice(0, 300);
}

export function closeAllMcp(): void {
  for (const c of conns.values()) void c.client.close().catch(() => {});
  conns.clear();
}
