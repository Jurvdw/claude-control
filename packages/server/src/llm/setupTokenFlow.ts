import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Locate the Claude CLI binary bundled with the Agent SDK. The app already
 * ships this for @anthropic-ai/claude-agent-sdk to spawn during agent runs, so
 * asking the user to separately "install Claude Code" is unnecessary — this
 * resolves the exact same binary the SDK itself uses.
 *
 * Platform packages follow npm's optional-dependency convention:
 * @anthropic-ai/claude-agent-sdk-<platform>-<arch>. Only win32-x64 is shipped
 * today (the desktop app is Windows-only); fail clearly on anything else
 * rather than silently returning a wrong path.
 */
export function resolveClaudeBinary(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`No bundled Claude binary for ${platform}-${arch} (only win32-x64 is shipped).`);
  }
  const pkgName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  return path.join(path.dirname(pkgJsonPath), 'claude.exe');
}

/**
 * Extract a setup-token from `claude setup-token`'s stdout. Tokens are
 * sk-ant-oat-prefixed; the CLI prints explanatory text around it, so this
 * matches the token itself rather than anchoring to a specific line format.
 */
export function parseSetupTokenOutput(stdout: string): string | null {
  const match = stdout.match(/sk-ant-oat[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}
