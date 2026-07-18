// One-click public tunnel for the local server, so inbound webhooks can reach
// the app from the internet without port-forwarding. Uses localtunnel (pure JS,
// no binary). App-global: a single tunnel exposes the whole HTTP port.

import { createRequire } from 'node:module';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);

interface Tunnel {
  url: string;
  close: () => void;
  on: (event: 'close' | 'error' | 'request', cb: (arg?: unknown) => void) => void;
}
type LocalTunnel = (opts: { port: number }) => Promise<Tunnel>;

let active: Tunnel | null = null;
let publicUrl: string | null = null;
let starting = false;

export function tunnelStatus(): { running: boolean; url: string | null } {
  return { running: !!active, url: publicUrl };
}

export async function startTunnel(): Promise<{ url: string }> {
  if (active && publicUrl) return { url: publicUrl };
  if (starting) throw new Error('Tunnel is already starting — try again in a moment');
  starting = true;
  try {
    const localtunnel = require('localtunnel') as LocalTunnel;
    const t = await localtunnel({ port: env.PORT });
    active = t;
    publicUrl = t.url;
    t.on('close', () => { active = null; publicUrl = null; logger.info('Tunnel closed'); });
    t.on('error', (err) => { logger.warn('Tunnel error', { error: String(err) }); });
    logger.info('Tunnel started', { url: publicUrl });
    return { url: publicUrl };
  } finally {
    starting = false;
  }
}

export function stopTunnel(): void {
  if (active) {
    try { active.close(); } catch { /* ignore */ }
  }
  active = null;
  publicUrl = null;
}
