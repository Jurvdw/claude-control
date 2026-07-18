import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

// Socket.IO rooms live on the CONNECTION, not the session. When the transport
// drops (backend restart, sleep/wake, network blip) it silently reconnects with
// a fresh connection belonging to NO rooms — so the UI looked perfectly
// connected and simply stopped receiving messages for the workspace, forever,
// until a manual reload. We remember what we joined and re-join on every
// connect.
const joined = new Set<string>();

// Fired after a RE-connect (not the first), so views can refetch whatever
// happened while the socket was down — re-joining a room does not backfill.
type Handler = () => void;
const reconnectHandlers = new Set<Handler>();
let hasConnectedOnce = false;

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', {
      withCredentials: true,
      // Localhost websocket is always available in the desktop app — skip the
      // long-polling handshake + upgrade dance (fewer requests, lower overhead).
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    socket.on('connect', () => {
      for (const serverId of joined) socket!.emit('server:join', { serverId });
      if (hasConnectedOnce) for (const h of reconnectHandlers) h();
      hasConnectedOnce = true;
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  joined.clear();
  hasConnectedOnce = false;
}

export function joinServer(serverId: string) {
  joined.add(serverId);
  getSocket().emit('server:join', { serverId });
}

export function leaveServer(serverId: string) {
  joined.delete(serverId);
  getSocket().emit('server:leave', { serverId });
}

/** Run `cb` whenever the socket comes back after a drop. Returns unsubscribe. */
export function onReconnect(cb: Handler): () => void {
  getSocket(); // ensure the connect handler is installed
  reconnectHandlers.add(cb);
  return () => { reconnectHandlers.delete(cb); };
}

/** Subscribe to connection state (for a "reconnecting…" indicator). */
export function onConnectionChange(cb: (connected: boolean) => void): () => void {
  const s = getSocket();
  const on = () => cb(true);
  const off = () => cb(false);
  s.on('connect', on);
  s.on('disconnect', off);
  cb(s.connected);
  return () => { s.off('connect', on); s.off('disconnect', off); };
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
