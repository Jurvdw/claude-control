// Server entrypoint: starts a local Postgres (no Docker), applies the schema,
// seeds starter templates, then boots HTTP + Socket.IO + the in-process runner.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './http.js';
import { attachSocketGateway } from './realtime/socket.js';
import { registerDispatch, startWorkers, setupSchedules, stopWorkers } from './queue/index.js';
import { startEmbeddedPostgres, stopEmbeddedPostgres, applySchema } from './db/embedded.js';
import { ensureSeed, reconcileAgentTools } from './db/seed.js';

async function main() {
  // 1. Local database (embedded Postgres child process — no Docker).
  await startEmbeddedPostgres();
  await applySchema();
  await ensureSeed();
  await reconcileAgentTools();
  logger.info('Database ready & seeded');

  // 2. Dispatcher must be registered before any route can enqueue agent runs.
  registerDispatch();

  // 3. HTTP + realtime.
  const app = createApp();
  const httpServer = createServer(app);
  attachSocketGateway(httpServer);

  // 4. In-process agent runner + schedule ticker.
  startWorkers();
  void setupSchedules();

  httpServer.listen(env.PORT, () => {
    const url = `http://localhost:${env.PORT}`;
    logger.info('Claude Control is running', { url });
    // Launcher sets OPEN_BROWSER=1 so the app pops open when it's truly ready.
    // No shell: execFile with an argument array (url is a validated localhost URL).
    if (process.env.OPEN_BROWSER === '1') {
      if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
      else if (process.platform === 'darwin') execFile('open', [url], () => {});
      else execFile('xdg-open', [url], () => {});
    }
  });

  // 5. Graceful shutdown — stop the local database cleanly.
  const shutdown = async (signal: string) => {
    logger.info(`Shutting down (${signal})…`);
    stopWorkers();
    httpServer.close();
    await prisma.$disconnect().catch(() => {});
    await stopEmbeddedPostgres();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  logger.error('Fatal boot error', { error: (err as Error).message });
  await stopEmbeddedPostgres().catch(() => {});
  process.exit(1);
});
