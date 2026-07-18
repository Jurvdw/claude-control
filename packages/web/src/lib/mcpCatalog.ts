// Curated MCP servers with prefilled configs + guided fields, so non-technical
// users can connect tools without knowing commands or where env vars go. Each
// "field" is either an `arg` (appended to the command) or an `env` secret; both
// carry a label, help text, and a link to where to get the value.

export interface McpField {
  kind: 'arg' | 'env';
  key: string;          // env var name, or a synthetic key for args
  label: string;
  help?: string;
  link?: string;        // where to get the value
  placeholder?: string;
}

export interface McpCatalogEntry {
  id: string;
  name: string;         // default tool prefix (mcp__<name>__*)
  icon: string;
  blurb: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  fields?: McpField[];
  needsNode?: boolean;  // stdio via npx → requires Node.js on the machine
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'filesystem', name: 'filesystem', icon: '📁',
    blurb: 'Let agents read and write files in a folder you choose.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], needsNode: true,
    fields: [{ kind: 'arg', key: 'path', label: 'Folder to allow', help: 'The one folder agents may access (e.g. C:\\Users\\you\\Documents).', placeholder: 'C:\\Users\\you\\Documents' }],
  },
  {
    id: 'github', name: 'github', icon: '🐙',
    blurb: 'Read/create issues & PRs, browse repos.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], needsNode: true,
    fields: [{ kind: 'env', key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub token', help: 'Create a fine-grained or classic token with repo access.', link: 'https://github.com/settings/tokens', placeholder: 'ghp_…' }],
  },
  {
    id: 'brave', name: 'brave', icon: '🔎',
    blurb: 'Web search via the Brave Search API.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], needsNode: true,
    fields: [{ kind: 'env', key: 'BRAVE_API_KEY', label: 'Brave API key', help: 'Free tier available; sign up and copy your key.', link: 'https://brave.com/search/api/', placeholder: 'BSA…' }],
  },
  {
    id: 'slack', name: 'slack', icon: '💬',
    blurb: 'Read channels and post messages to Slack.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], needsNode: true,
    fields: [
      { kind: 'env', key: 'SLACK_BOT_TOKEN', label: 'Slack bot token', help: 'Create a Slack app, add bot scopes, and install it.', link: 'https://api.slack.com/apps', placeholder: 'xoxb-…' },
      { kind: 'env', key: 'SLACK_TEAM_ID', label: 'Slack team ID', help: 'Your workspace ID (starts with T).', placeholder: 'T01234567' },
    ],
  },
  {
    id: 'postgres', name: 'postgres', icon: '🐘',
    blurb: 'Query a Postgres database (read-only).',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], needsNode: true,
    fields: [{ kind: 'arg', key: 'conn', label: 'Connection URL', help: 'A Postgres connection string.', placeholder: 'postgresql://user:pass@host:5432/db' }],
  },
  {
    id: 'memory', name: 'memory', icon: '🧠',
    blurb: 'A simple knowledge-graph memory the agent can persist to.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], needsNode: true,
  },
  {
    id: 'everything', name: 'everything', icon: '🧪',
    blurb: 'Reference/test server (echo, add, etc.) — good for a first try.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], needsNode: true,
  },
];
