// In-process job runner — no Redis/BullMQ. Agent runs execute in this process
// with a small concurrency limit; schedules are checked on an interval using
// cron-parser; parked runs auto-resume via durable ResumeJob rows (DB-backed, so
// they survive restarts and multi-hour usage-limit waits). This keeps the app a
// single self-contained process (ideal for the local executable).

import { createRequire } from 'node:module';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { runAgent } from '../agents/runLoop.js';
import { setDispatcher, enqueueAgentRun, type AgentTrigger } from '../agents/dispatch.js';
import { bus } from '../realtime/bus.js';
import { runWorkflow } from '../workflows/engine.js';

// cron-parser v4 is CommonJS (no ESM named export) — load it via require.
const require = createRequire(import.meta.url);
const { parseExpression } = require('cron-parser') as {
  parseExpression: (expr: string, opts?: { currentDate?: Date }) => { next: () => { toDate: () => Date } };
};

const MAX_CONCURRENT = 3;
const queue: AgentTrigger[] = [];
let running = 0;

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const trigger = queue.shift()!;
    running++;
    runAgent(trigger)
      .catch((err) => logger.error('agent run failed', { error: (err as Error).message }))
      .finally(() => {
        running--;
        setImmediate(pump);
      });
  }
}

function enqueue(trigger: AgentTrigger): void {
  queue.push(trigger);
  setImmediate(pump);
}

export function registerDispatch(): void {
  setDispatcher(async (trigger) => enqueue(trigger));
}

let scheduleTimer: ReturnType<typeof setInterval> | null = null;

export function startWorkers(): void {
  scheduleTimer = setInterval(() => {
    void tickSchedules();
    void tickWorkflowSchedules();
    void tickResumeJobs();
  }, 30_000);
  logger.info('In-process agent runner started', { maxConcurrent: MAX_CONCURRENT });
}

export async function setupSchedules(): Promise<void> {
  // No repeatable-job registration needed; the interval tick handles due work.
  // Fire once on boot so anything that came due during downtime resumes promptly.
  await tickSchedules();
  await tickResumeJobs();
}

// Mechanically re-enqueue runs that were parked on a usage/rate limit, once their
// resume time has arrived. Purely time-based — no AI involved. DB-backed, so a
// long overnight wait resumes even if the app restarted in the meantime.
async function tickResumeJobs(): Promise<void> {
  try {
    const due = await prisma.resumeJob.findMany({
      where: { status: 'pending', resumeAt: { lte: new Date() } },
      take: 20,
    });
    for (const job of due) {
      // Claim atomically so a job never fires twice (e.g. overlapping ticks).
      const claimed = await prisma.resumeJob.updateMany({
        where: { id: job.id, status: 'pending' },
        data: { status: 'done' },
      });
      if (claimed.count === 0) continue;
      bus.emit('run.resumed', { serverId: job.serverId, agentId: job.agentId });
      enqueue(job.trigger as unknown as AgentTrigger);
      logger.info('Resumed parked run', { serverId: job.serverId, agentId: job.agentId, attempt: job.attempt });
    }
  } catch (err) {
    logger.warn('resume-job tick failed', { error: (err as Error).message });
  }
}

export function stopWorkers(): void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
}

// Check which enabled schedules are due since their last run and fire them.
async function tickSchedules(): Promise<void> {
  try {
    const schedules = await prisma.schedule.findMany({ where: { enabled: true } });
    const now = new Date();
    for (const s of schedules) {
      let due = false;
      try {
        const since = s.lastRunAt ?? new Date(now.getTime() - 60_000);
        const next = parseExpression(s.cron, { currentDate: since }).next().toDate();
        due = next <= now;
      } catch {
        continue; // invalid cron — skip
      }
      if (!due) continue;
      await prisma.schedule.update({ where: { id: s.id }, data: { lastRunAt: now } });
      await fireSchedule(s.id);
    }
  } catch (err) {
    logger.warn('schedule tick failed', { error: (err as Error).message });
  }
}

// Fire enabled workflows whose trigger.schedule cron is due since their last run.
async function tickWorkflowSchedules(): Promise<void> {
  try {
    const workflows = await prisma.workflow.findMany({ where: { enabled: true } });
    const now = new Date();
    for (const w of workflows) {
      const graph = (w.graph ?? {}) as { nodes?: { type: string; data?: { cron?: string } }[] };
      const cron = graph.nodes?.find((n) => n.type === 'trigger.schedule')?.data?.cron;
      if (!cron) continue;
      let due = false;
      try {
        const since = w.lastRunAt ?? new Date(now.getTime() - 60_000);
        const next = parseExpression(cron, { currentDate: since }).next().toDate();
        due = next <= now;
      } catch {
        continue; // invalid cron
      }
      if (!due) continue;
      // Claim the slot before running to avoid a double-fire within the window.
      await prisma.workflow.update({ where: { id: w.id }, data: { lastRunAt: now } });
      await runWorkflow(w.id, { trigger: 'schedule' }).catch((err) =>
        logger.warn('scheduled workflow failed', { id: w.id, error: (err as Error).message }),
      );
    }
  } catch (err) {
    logger.warn('workflow schedule tick failed', { error: (err as Error).message });
  }
}

async function fireSchedule(scheduleId: string): Promise<void> {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule || !schedule.enabled) return;

  let agentId = schedule.agentId;
  if (!agentId) {
    const mgr = await prisma.agent.findFirst({
      where: { serverId: schedule.serverId, isManager: true, enabled: true },
    });
    if (!mgr) {
      logger.warn('No manager agent for scheduled job', { scheduleId });
      return;
    }
    agentId = mgr.id;
  }

  await enqueueAgentRun({
    serverId: schedule.serverId,
    agentId,
    trigger: 'schedule',
    channelId: schedule.channelId,
    prompt: schedule.prompt,
  });
}
