import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@prisma/client';
import { prisma } from './prisma.js';
import { decrypt } from './crypto.js';
import { logger } from './logger.js';
import { checkMcpPaths } from './mcpFence.js';

// Turn a stored McpServer row into an Agent SDK MCP config. `alwaysLoad` keeps
// the tools present in the prompt (they'd otherwise be deferred behind tool
// search); the 5s connect cap keeps a dead server from hanging the run.
function toConfig(row: McpServer): McpServerConfig | null {
  let secrets: { env?: Record<string, string>; headers?: Record<string, string> } = {};
  if (row.secretsEnc) {
    try { secrets = JSON.parse(decrypt(row.secretsEnc)); } catch { /* ignore */ }
  }
  const args = Array.isArray(row.args) ? (row.args as string[]) : [];
  // Second line of defence: rows written before the fence existed (or restored
  // from a backup) are re-checked here, at load time.
  const fenced = checkMcpPaths({ command: row.command, args, env: secrets.env });
  if (fenced) {
    logger.warn('blocked MCP server pointing at the app itself', { name: row.name });
    return null;
  }
  if (row.transport === 'stdio') {
    if (!row.command) return null;
    return { type: 'stdio', command: row.command, args, env: secrets.env, alwaysLoad: true };
  }
  if (row.transport === 'sse') {
    if (!row.url) return null;
    return { type: 'sse', url: row.url, headers: secrets.headers, alwaysLoad: true };
  }
  if (row.transport === 'http') {
    if (!row.url) return null;
    return { type: 'http', url: row.url, headers: secrets.headers, alwaysLoad: true };
  }
  return null;
}

// Build the { name → config } map of enabled external MCP servers for a workspace.
// Used only in subscription (Agent SDK) mode, which owns MCP natively.
export async function loadMcpServers(serverId: string): Promise<Record<string, McpServerConfig>> {
  const rows = await prisma.mcpServer.findMany({ where: { serverId, enabled: true } });
  const out: Record<string, McpServerConfig> = {};
  for (const row of rows) {
    const cfg = toConfig(row);
    if (cfg) out[row.name] = cfg;
    else logger.warn('skipping malformed MCP server', { name: row.name });
  }
  return out;
}
