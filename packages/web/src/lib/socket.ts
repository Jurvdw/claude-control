import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', {
      withCredentials: true,
      // Localhost websocket is always available in the desktop app — skip the
      // long-polling handshake + upgrade dance (fewer requests, lower overhead).
      transports: ['websocket'],
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function joinServer(serverId: string) {
  getSocket().emit('server:join', { serverId });
}

export function leaveServer(serverId: string) {
  getSocket().emit('server:leave', { serverId });
}

export function emitTyping(serverId: string, channelId: string) {
  getSocket().emit('typing', { serverId, channelId });
}

type EventCallback = (...args: unknown[]) => void;

export function onSocketEvent(event: string, cb: EventCallback): () => void {
  getSocket().on(event, cb);
  return () => {
    getSocket().off(event, cb);
  };
}
