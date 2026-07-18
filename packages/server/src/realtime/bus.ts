import { EventEmitter } from 'node:events';

// Domain event bus. The agent run loop and services emit here; the Socket.IO
// gateway (src/realtime/socket.ts) subscribes and forwards to clients. This
// decouples business logic from the transport.

export interface BusEvents {
  'agent.status': {
    serverId: string;
    agentId: string;
    status: string;
    thinkingLine?: string;
  };
  'message.created': {
    serverId: string;
    channelId?: string | null;
    dmThreadId?: string | null;
    message: unknown;
  };
  'task.updated': { serverId: string; task: unknown };
  'brain.updated': { serverId: string; note: unknown };
  'proposal.created': { serverId: string; proposal: unknown };
  'approval.created': { serverId: string; approval: unknown };
  'approval.updated': { serverId: string; approval: unknown };
  'run.parked': { serverId: string; agentId: string; resetAt?: string; runId?: string };
  'run.resumed': { serverId: string; agentId: string };
  'run.finished': { serverId: string; run: unknown };
  'workflow.updated': { serverId: string; workflow: unknown };
  'workflow.run': { serverId: string; workflowId: string; run: unknown };
  'plan.updated': { serverId: string; plan: unknown };
  'question.updated': { serverId: string; question: unknown };
  'emailDraft.updated': { serverId: string; draft: unknown };
  notification: { userId: string; notification: unknown };
}

type Handler<T> = (payload: T) => void;

class TypedBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event as string, payload);
  }

  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): void {
    this.emitter.on(event as string, handler as (p: unknown) => void);
  }
}

export const bus = new TypedBus();
