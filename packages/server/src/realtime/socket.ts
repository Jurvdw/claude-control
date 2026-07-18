// Socket.IO gateway — authenticates via cc_session cookie, joins rooms,
// and bridges the internal event bus to WebSocket clients.

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import { env } from '../config/env.js';
import { getSessionUser } from '../auth/session.js';
import { getMembership } from '../auth/guards.js';
import { bus } from './bus.js';
import { logger } from '../lib/logger.js';

// Dot-to-colon event name mapping per API_CONTRACT.md.
const BUS_TO_SOCKET: Record<string, string> = {
  'agent.status': 'agent:status',
  'message.created': 'message:created',
  'task.updated': 'task:updated',
  'brain.updated': 'brain:updated',
  'proposal.created': 'proposal:created',
  'approval.created': 'approval:created',
  'approval.updated': 'approval:updated',
  'run.parked': 'run:parked',
  'run.resumed': 'run:resumed',
  'run.finished': 'run:finished',
  'workflow.updated': 'workflow:updated',
  'workflow.run': 'workflow:run',
  'plan.updated': 'plan:updated',
  'question.updated': 'question:updated',
  'emailDraft.updated': 'emaildraft:updated',
};

export function attachSocketGateway(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.APP_URL,
      credentials: true,
    },
  });

  // ── Authentication middleware ─────────────────────────────────────────────

  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? '';
      const cookies = parseCookie(cookieHeader);
      const sid = cookies['cc_session'];
      if (!sid) return next(new Error('unauthenticated'));

      const user = await getSessionUser(sid);
      if (!user) return next(new Error('unauthenticated'));

      socket.data.userId = user.id;
      next();
    } catch (err) {
      next(new Error('auth error'));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────────

  io.on('connection', (socket) => {
    const userId: string = socket.data.userId as string;
    socket.join(`user:${userId}`);
    logger.debug('socket connected', { userId, socketId: socket.id });

    socket.on('server:join', async ({ serverId }: { serverId: string }) => {
      if (!serverId) return;
      const membership = await getMembership(userId, serverId);
      if (!membership) return; // silently ignore non-members
      await socket.join(`server:${serverId}`);
    });

    socket.on('server:leave', ({ serverId }: { serverId: string }) => {
      if (serverId) void socket.leave(`server:${serverId}`);
    });

    // Optional typing broadcast
    socket.on('typing', ({ serverId, channelId }: { serverId: string; channelId: string }) => {
      if (serverId && channelId) {
        socket.to(`server:${serverId}`).emit('typing', { serverId, channelId, userId });
      }
    });

    socket.on('disconnect', () => {
      logger.debug('socket disconnected', { userId, socketId: socket.id });
    });
  });

  // ── Bus → Socket bridge ───────────────────────────────────────────────────

  // Server-scoped events — forwarded to server room.
  const serverEvents = [
    'agent.status',
    'message.created',
    'task.updated',
    'brain.updated',
    'proposal.created',
    'approval.created',
    'approval.updated',
    'run.parked',
    'run.resumed',
    'run.finished',
    'workflow.updated',
    'workflow.run',
    'plan.updated',
    'question.updated',
    'emailDraft.updated',
  ] as const;

  for (const busEvent of serverEvents) {
    bus.on(busEvent, (payload) => {
      const socketEvent = BUS_TO_SOCKET[busEvent];
      const data = payload as { serverId: string };
      io.to(`server:${data.serverId}`).emit(socketEvent, payload);
    });
  }

  // Notification — forwarded to user room.
  bus.on('notification', (payload) => {
    io.to(`user:${payload.userId}`).emit('notification', { notification: payload.notification });
  });

  return io;
}
