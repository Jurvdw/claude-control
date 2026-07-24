import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import type { Server, Channel, Agent, Message, Task, BrainNote, Approval, Proposal, RunParkedEvent } from '../lib/types';
import { servers as serversApi, channels as channelsApi, agents as agentsApi, tasks as tasksApi, brain as brainApi, approvals as approvalsApi } from '../lib/api';
import { joinServer, leaveServer, onSocketEvent, onReconnect } from '../lib/socket';
import { useAuth } from './AuthContext';

interface ParkedInfo {
  agentId: string;
  resetAt?: string;
}

interface ServerContextValue {
  servers: Server[];
  activeServer: Server | null;
  channels: Channel[];
  activeChannel: Channel | null;
  agents: Agent[];
  messages: Message[];
  tasks: Task[];
  brainNotes: BrainNote[];
  approvals: Approval[];
  proposals: Proposal[];
  parkedAgents: Record<string, ParkedInfo>;
  loadingMessages: boolean;
  setActiveServer: (server: Server | null) => void;
  setActiveChannel: (channel: Channel | null) => void;
  refreshServers: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshApprovals: () => Promise<void>;
  refreshProposals: () => Promise<void>;
  appendMessage: (msg: Message) => void;
  loadMoreMessages: () => Promise<void>;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [serverList, setServerList] = useState<Server[]>([]);
  const [activeServer, setActiveServerState] = useState<Server | null>(null);
  const [channelList, setChannelList] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannelState] = useState<Channel | null>(null);
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [messageList, setMessageList] = useState<Message[]>([]);
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [brainNotes, setBrainNotes] = useState<BrainNote[]>([]);
  const [approvalList, setApprovalList] = useState<Approval[]>([]);
  const [proposalList, setProposalList] = useState<Proposal[]>([]);
  const [parkedAgents, setParkedAgents] = useState<Record<string, ParkedInfo>>({});
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Load servers on mount
  useEffect(() => {
    if (!user) { setServerList([]); return; }
    serversApi.list().then(({ servers }) => setServerList(servers)).catch(() => {});
  }, [user]);

  const refreshServers = useCallback(async () => {
    const { servers } = await serversApi.list();
    setServerList(servers);
  }, []);

  const setActiveServer = useCallback(async (server: Server | null) => {
    if (activeServer) leaveServer(activeServer.id);
    setActiveServerState(server);
    setChannelList([]);
    setAgentList([]);
    setMessageList([]);
    setTaskList([]);
    setBrainNotes([]);
    setApprovalList([]);
    setProposalList([]);
    setParkedAgents({});
    setActiveChannelState(null);

    if (!server) return;
    joinServer(server.id);

    const [{ channels }, { agents }, { tasks }] = await Promise.all([
      channelsApi.list(server.id),
      agentsApi.list(server.id),
      tasksApi.list(server.id),
    ]);
    setChannelList(channels);
    setAgentList(agents);
    setTaskList(tasks);

    // Auto-select default channel AND load its messages. Using the raw state
    // setter here skipped the fetch that setActiveChannel does, so opening a
    // workspace showed "This is the start of #general" on a channel with full
    // history — it only populated once you clicked the channel by hand.
    const def = channels.find(c => c.isDefault) || channels[0];
    if (def) {
      setActiveChannelState(def);
      setLoadingMessages(true);
      import('../lib/api').then(({ messages: msgApi }) =>
        msgApi.list(server.id, def.id)
          .then(({ messages }) => setMessageList(messages))
          .catch(() => {})
          .finally(() => setLoadingMessages(false)),
      );
    }

    brainApi.listNotes(server.id).then(({ notes }) => setBrainNotes(notes)).catch(() => {});
    approvalsApi.list(server.id).then(({ approvals }) => setApprovalList(approvals)).catch(() => {});
    brainApi.listProposals(server.id).then(({ proposals }) => setProposalList(proposals)).catch(() => {});
  }, [activeServer]);

  const setActiveChannel = useCallback((channel: Channel | null) => {
    setActiveChannelState(channel);
    setMessageList([]);
    if (!channel || !activeServer) return;
    setLoadingMessages(true);
    import('../lib/api').then(({ messages: msgApi }) =>
      msgApi.list(activeServer.id, channel.id)
        .then(({ messages }) => setMessageList(messages))
        .catch(() => {})
        .finally(() => setLoadingMessages(false))
    );
  }, [activeServer]);

  const loadMoreMessages = useCallback(async () => {
    if (!activeServer || !activeChannel || messageList.length === 0) return;
    const oldest = messageList[0];
    // `before` must be a timestamp the server can parse with `new Date(...)` —
    // oldest.id is a CUID, not a date, and was silently producing an Invalid
    // Date on the server (a distinct bug from the pagination direction fix).
    const { messages } = await import('../lib/api').then(m => m.messages.list(activeServer.id, activeChannel.id, oldest.createdAt));
    setMessageList(prev => [...messages, ...prev]);
  }, [activeServer, activeChannel, messageList]);

  const appendMessage = useCallback((msg: Message) => {
    // Dedupe by id — the sender appends optimistically AND the socket echoes it.
    setMessageList(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  const refreshAgents = useCallback(async () => {
    if (!activeServer) return;
    const { agents } = await agentsApi.list(activeServer.id);
    setAgentList(agents);
  }, [activeServer]);

  const refreshTasks = useCallback(async () => {
    if (!activeServer) return;
    const { tasks } = await tasksApi.list(activeServer.id);
    setTaskList(tasks);
  }, [activeServer]);

  const refreshApprovals = useCallback(async () => {
    if (!activeServer) return;
    const { approvals } = await approvalsApi.list(activeServer.id);
    setApprovalList(approvals);
  }, [activeServer]);

  const refreshProposals = useCallback(async () => {
    if (!activeServer) return;
    const { proposals } = await brainApi.listProposals(activeServer.id);
    setProposalList(proposals);
  }, [activeServer]);

  // Socket event handlers
  useEffect(() => {
    if (!activeServer) return;

    const offs = [
      // Re-joining a room after a dropped connection does not replay what was
      // missed, so refetch the open channel. Without this you reconnect and
      // still never see the reply that arrived while you were disconnected.
      onReconnect(() => {
        if (!activeServer || !activeChannel) return;
        import('../lib/api').then(({ messages: msgApi }) =>
          msgApi.list(activeServer.id, activeChannel.id)
            .then(({ messages }) => setMessageList(messages))
            .catch(() => {}),
        );
      }),

      onSocketEvent('agent:status', (data: unknown) => {
        const { agentId, status, thinkingLine } = data as { serverId: string; agentId: string; status: string; thinkingLine?: string };
        setAgentList(prev => prev.map(a => a.id === agentId ? { ...a, status: status as Agent['status'], thinkingLine } : a));
      }),

      onSocketEvent('message:created', (data: unknown) => {
        const { channelId, message } = data as { serverId: string; channelId?: string; message: Message };
        if (channelId === activeChannel?.id) {
          setMessageList(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]));
        }
      }),

      onSocketEvent('task:updated', (data: unknown) => {
        const { task } = data as { serverId: string; task: Task };
        setTaskList(prev => prev.map(t => t.id === task.id ? task : t));
      }),

      onSocketEvent('brain:updated', (data: unknown) => {
        const { note } = data as { serverId: string; note: BrainNote };
        setBrainNotes(prev => {
          const idx = prev.findIndex(n => n.id === note.id);
          if (idx >= 0) { const n = [...prev]; n[idx] = note; return n; }
          return [...prev, note];
        });
      }),

      onSocketEvent('proposal:created', (data: unknown) => {
        const { proposal } = data as { serverId: string; proposal: Proposal };
        setProposalList(prev => [proposal, ...prev]);
      }),

      onSocketEvent('approval:created', (data: unknown) => {
        const { approval } = data as { serverId: string; approval: Approval };
        setApprovalList(prev => [approval, ...prev]);
      }),

      onSocketEvent('approval:updated', (data: unknown) => {
        const { approval } = data as { serverId: string; approval: Approval };
        setApprovalList(prev => prev.map(a => a.id === approval.id ? approval : a));
      }),

      onSocketEvent('run:parked', (data: unknown) => {
        const { agentId, resetAt } = data as RunParkedEvent;
        setParkedAgents(prev => ({ ...prev, [agentId]: { agentId, resetAt } }));
      }),

      onSocketEvent('run:resumed', (data: unknown) => {
        const { agentId } = data as { agentId: string };
        setParkedAgents(prev => { const n = { ...prev }; delete n[agentId]; return n; });
      }),
    ];

    return () => offs.forEach(off => off());
  }, [activeServer, activeChannel]);

  const value = useMemo<ServerContextValue>(() => ({
    servers: serverList,
    activeServer,
    channels: channelList,
    activeChannel,
    agents: agentList,
    messages: messageList,
    tasks: taskList,
    brainNotes,
    approvals: approvalList,
    proposals: proposalList,
    parkedAgents,
    loadingMessages,
    setActiveServer,
    setActiveChannel,
    refreshServers,
    refreshAgents,
    refreshTasks,
    refreshApprovals,
    refreshProposals,
    appendMessage,
    loadMoreMessages,
  }), [
    serverList, activeServer, channelList, activeChannel, agentList, messageList,
    taskList, brainNotes, approvalList, proposalList, parkedAgents, loadingMessages,
    setActiveServer, setActiveChannel, refreshServers, refreshAgents, refreshTasks,
    refreshApprovals, refreshProposals, appendMessage, loadMoreMessages,
  ]);

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer() {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer must be used within ServerProvider');
  return ctx;
}
