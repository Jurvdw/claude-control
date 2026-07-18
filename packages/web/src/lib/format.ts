// Shared display formatters (cost, tokens, duration, bytes) used across the
// activity, usage, and message views.

export function fmtCost(n: number): string {
  if (n === 0) return '$0';
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
