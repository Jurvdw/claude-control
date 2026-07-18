import type { WorkflowGraph } from './types';

// Pre-built starter workflows. Nodes intentionally leave agentId/channelId
// blank so the user wires them up in the config drawer after inserting.
export interface WorkflowTemplate {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  build: () => WorkflowGraph;
}

const pos = (x: number, y: number) => ({ x, y });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'daily-digest',
    name: 'Daily digest',
    icon: '🗞️',
    blurb: 'Every morning, an agent writes a summary and posts it to a channel.',
    build: () => ({
      nodes: [
        { id: 't', type: 'trigger.schedule', position: pos(60, 160), data: { cron: '0 9 * * *' } },
        { id: 'a', type: 'agent.run', position: pos(300, 160), data: { prompt: 'Write a short daily digest of anything important from the last 24h.' } },
        { id: 'p', type: 'channel.post', position: pos(560, 160), data: { text: '{{input}}' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'p' },
      ],
    }),
  },
  {
    id: 'research-to-brain',
    name: 'Research → Brain',
    icon: '🧠',
    blurb: 'Run an agent on demand and file its findings as a Brain note.',
    build: () => ({
      nodes: [
        { id: 't', type: 'trigger.manual', position: pos(60, 160), data: {} },
        { id: 'a', type: 'agent.run', position: pos(300, 160), data: { prompt: 'Research the topic and produce a concise, well-structured note.' } },
        { id: 'b', type: 'brain.write', position: pos(560, 160), data: { title: 'Research', folder: 'Research', content: '{{input}}' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    }),
  },
  {
    id: 'web-watch',
    name: 'Watch a URL',
    icon: '🌐',
    blurb: 'Fetch a page on a schedule; if it mentions something, have an agent post an alert.',
    build: () => ({
      nodes: [
        { id: 't', type: 'trigger.schedule', position: pos(40, 160), data: { cron: '0 * * * *' } },
        { id: 'h', type: 'http.request', position: pos(260, 160), data: { method: 'GET', url: 'https://example.com', headers: '', body: '' } },
        { id: 'c', type: 'condition', position: pos(500, 160), data: { mode: 'contains', value: 'keyword' } },
        { id: 'a', type: 'agent.run', position: pos(740, 90), data: { prompt: 'Summarize what changed and why it matters:\n\n{{input}}' } },
        { id: 'p', type: 'channel.post', position: pos(980, 90), data: { text: '🔔 {{input}}' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'h' },
        { id: 'e2', source: 'h', target: 'c' },
        { id: 'e3', source: 'c', target: 'a', sourceHandle: 'true' },
        { id: 'e4', source: 'a', target: 'p' },
      ],
    }),
  },
  {
    id: 'scheduled-report',
    name: 'Scheduled report',
    icon: '📊',
    blurb: 'Weekly: an agent compiles a report, saves it to the Brain, and announces it.',
    build: () => ({
      nodes: [
        { id: 't', type: 'trigger.schedule', position: pos(40, 160), data: { cron: '0 17 * * 5' } },
        { id: 'a', type: 'agent.run', position: pos(280, 160), data: { prompt: 'Compile this week’s report with sections and highlights.' } },
        { id: 'b', type: 'brain.write', position: pos(540, 90), data: { title: 'Weekly report', folder: 'Reports', content: '{{input}}' } },
        { id: 'p', type: 'channel.post', position: pos(540, 240), data: { text: '📊 Weekly report is ready.\n\n{{input}}' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'a', target: 'p' },
      ],
    }),
  },
  {
    id: 'webhook-handler',
    name: 'Webhook → agent',
    icon: '🪝',
    blurb: 'An incoming API call runs an agent on the payload and posts the result.',
    build: () => ({
      nodes: [
        { id: 't', type: 'trigger.webhook', position: pos(60, 160), data: { event: '' } },
        { id: 'a', type: 'agent.run', position: pos(320, 160), data: { prompt: 'Handle this incoming webhook payload and summarize what to do:\n\n{{input}}' } },
        { id: 'p', type: 'channel.post', position: pos(580, 160), data: { text: '{{input}}' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'p' },
      ],
    }),
  },
  {
    id: 'delayed-followup',
    name: 'Delayed follow-up',
    icon: '⏱',
    blurb: 'Kick off manually, wait, then have an agent follow up in a channel.',
    build: () => ({
      nodes: [
        { id: 't', type: 'trigger.manual', position: pos(60, 160), data: {} },
        { id: 'd', type: 'delay', position: pos(300, 160), data: { seconds: 60 } },
        { id: 'a', type: 'agent.run', position: pos(520, 160), data: { prompt: 'Write a friendly follow-up message.' } },
        { id: 'p', type: 'channel.post', position: pos(780, 160), data: { text: '{{input}}' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'd' },
        { id: 'e2', source: 'd', target: 'a' },
        { id: 'e3', source: 'a', target: 'p' },
      ],
    }),
  },
];
