/* Minimal structured logger — swap for pino later if needed. */
import { createWriteStream, mkdirSync, statSync, renameSync, existsSync, type WriteStream } from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

// In the packaged desktop app the backend is a child process whose stdout is
// piped to the Electron parent — which, as a Windows GUI process, has no
// console attached. Every log line therefore went nowhere the moment the app
// was packaged: no crash diagnosis, no way for a user to report what happened,
// and no way to read instrumentation that only reproduces in production.
//
// So also write to a file under the app's data dir. LOG_DIR is set by the
// desktop shell; without it (dev, tests) this stays console-only and no file
// is created.
const MAX_BYTES = 5 * 1024 * 1024;
let stream: WriteStream | null = null;
let logPath = '';

/**
 * Where to write. LOG_DIR is set by the desktop shell — but the shell lives in
 * app.asar and only changes on a full reinstall, so fall back to deriving the
 * path from PG_DATA_DIR (…/userData/pg → …/userData/logs). That makes file
 * logging work on installs whose shell predates LOG_DIR, which is the case
 * exactly when you most need the logs. Dev and tests set neither and stay
 * console-only.
 */
function resolveDir(): string | null {
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  const pg = process.env.PG_DATA_DIR;
  return pg ? path.join(path.dirname(pg), 'logs') : null;
}

function open(): WriteStream | null {
  if (stream) return stream;
  const dir = resolveDir();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'server.log');
    // Single rotation: keep the previous run's tail for post-mortem without
    // letting a long-lived install grow the file without bound.
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, path.join(dir, 'server.prev.log'));
    }
    stream = createWriteStream(logPath, { flags: 'a' });
    // Logging must never take the app down — a full disk or a locked file is
    // not a reason to crash the backend.
    stream.on('error', () => { stream = null; });
  } catch {
    stream = null;
  }
  return stream;
}

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line);
  try {
    open()?.write(line + '\n');
  } catch {
    /* never let logging break a request */
  }
}

/** Where the log file lives, for surfacing in the UI. Empty until first write. */
export function logFilePath(): string {
  open();
  return logPath;
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => log('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
};
