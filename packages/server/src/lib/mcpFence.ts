import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Filesystem fence for MCP servers.
 *
 * Agents are free to learn about themselves (describe_self) and to ask for new
 * powers through official channels (request_capability / propose_self_improvement),
 * but they must never be able to REWRITE the app they run inside. The only
 * plausible route to that is a filesystem-style MCP server pointed at Claude
 * Control's own install/source/data directory, so we block those paths at the
 * point where an MCP server is configured.
 *
 * The check is deliberately conservative: any argument or env value that
 * resolves inside a protected root — or is an ancestor of one (e.g. `C:\` or the
 * home folder) — is rejected.
 */

const serverRoot = path.resolve(fileURLToPath(import.meta.url), '../../..'); // packages/server | resources/server

function protectedRoots(): string[] {
  const roots = [
    serverRoot, // the backend itself (src/dist)
    path.resolve(serverRoot, '..'), // repo root in dev, resources/ in the installed app
    path.dirname(process.execPath), // Electron install dir
  ];
  const appData = process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(process.env.HOME ?? '', '.config');
  if (appData) roots.push(path.join(appData, 'Claude Control')); // user data: DB, secrets.json
  return roots.map((r) => path.resolve(r));
}

function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Does this string look like a filesystem path we should resolve? Skips flags
// (`--foo`) and npm package specs (`@scope/pkg`, `some-server/dist`), which are
// forward-slashed and never start with `.`, `~` or a drive letter — resolving
// those against cwd would false-positive on every catalog entry.
function looksLikePath(s: string): boolean {
  if (!s || s.startsWith('-')) return false;
  return path.isAbsolute(s) || s.includes('\\') || s.startsWith('~') || /^\.\.?([\\/]|$)/.test(s) || /^[a-zA-Z]:/.test(s);
}

/**
 * Returns an error message if the config would give an MCP server access to the
 * app's own files, else null.
 */
export function checkMcpPaths(cfg: { command?: string | null; args?: unknown; env?: Record<string, string> }): string | null {
  const roots = protectedRoots();
  const candidates: string[] = [];
  if (Array.isArray(cfg.args)) for (const a of cfg.args) if (typeof a === 'string') candidates.push(a);
  for (const v of Object.values(cfg.env ?? {})) candidates.push(v);

  for (const raw of candidates) {
    if (!looksLikePath(raw)) continue;
    let resolved: string;
    try {
      resolved = path.resolve(raw.replace(/^["']|["']$/g, ''));
    } catch {
      continue;
    }
    for (const root of roots) {
      // Inside a protected root, or an ancestor of one (a broad root like C:\
      // or the home folder would expose the app just as effectively).
      if (contains(root, resolved) || contains(resolved, root)) {
        return `That path (${raw}) would give the MCP server access to Claude Control's own files. Pick a specific folder outside the app — agents can't be allowed to modify the app they run in. If you need a new ability, ask an agent to use request_capability instead.`;
      }
    }
  }
  return null;
}
