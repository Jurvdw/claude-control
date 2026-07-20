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

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { persistSubscriptionToken } from './index.js';

export type SetupTokenStatus = 'waiting' | 'success' | 'error';

interface Session {
  status: SetupTokenStatus;
  error?: string;
  child: ChildProcess;
}

const sessions = new Map<string, Session>();

type SpawnFn = (command: string, args: readonly string[]) => ChildProcess;

/**
 * Start (or restart) the setup-token flow for a user. Spawns the bundled
 * `claude setup-token`, which opens the user's browser for Anthropic sign-in.
 * On success the token is captured from stdout and persisted immediately —
 * callers never see the raw token, only the resulting status.
 */
export function startSetupToken(userId: string, spawnFn: SpawnFn = realSpawn): void {
  cancelSetupToken(userId); // replace any in-flight session for this user

  const child = spawnFn(resolveClaudeBinary(), ['setup-token']);
  const session: Session = { status: 'waiting', child };
  sessions.set(userId, session);

  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.on('error', (err) => {
    session.status = 'error';
    session.error = err.message;
  });

  child.on('exit', (code) => {
    if (session.status !== 'waiting') return; // already cancelled — see cancelSetupToken
    const token = parseSetupTokenOutput(stdout);
    if (code !== 0 || !token) {
      session.status = 'error';
      session.error =
        code !== 0
          ? 'Sign-in did not complete. Close the browser tab and try again, or paste a token manually.'
          : "Couldn't read the token from the sign-in flow. Paste it manually below.";
      return;
    }
    persistSubscriptionToken(userId, token)
      .then((result) => {
        if (result.valid) {
          session.status = 'success';
        } else {
          session.status = 'error';
          session.error = result.error ?? 'That token was rejected.';
        }
      })
      .catch((err) => {
        session.status = 'error';
        session.error = (err as Error).message;
      });
  });
}

/** Current status for a user's in-flight (or just-finished) setup-token flow. */
export function getSetupTokenStatus(userId: string): { status: SetupTokenStatus; error?: string } | null {
  const session = sessions.get(userId);
  if (!session) return null;
  return session.error ? { status: session.status, error: session.error } : { status: session.status };
}

/** Kill the in-flight child process, if any, and drop the session. */
export function cancelSetupToken(userId: string): void {
  const session = sessions.get(userId);
  if (session) {
    session.status = 'error'; // makes a late 'exit' handler on the old child a no-op
    session.child.kill();
    sessions.delete(userId);
  }
}
