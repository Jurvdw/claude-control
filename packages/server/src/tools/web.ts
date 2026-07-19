import { registerTool } from './registry.js';

// web_search is a CAPABILITY FLAG, not a client-side tool: search runs
// server-side inside the model call, so it never reaches the execute() below.
// Granting it to an agent switches on the real search tool in the provider —
// see subscription.ts (maps it to the Agent SDK's native WebSearch and is the
// only built-in tool we re-enable). The registration here is what makes it
// appear in the agent tool picker and in enabledTools.
//
// Both providers wire it: subscription → the Agent SDK's native WebSearch,
// API key → Anthropic's server-side web_search tool (see anthropic.ts). The
// execute() below is therefore unreachable on both paths and exists only so a
// future provider without search degrades honestly instead of hallucinating.
registerTool({
  name: 'web_search',
  description: 'Search the web for current information (Anthropic server-side web search).',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  async execute(input) {
    return (
      `Web search is unavailable in this run (no native search tool on the current provider), so "${input.query}" was NOT searched. ` +
      'Answer from what you already know and say plainly that you could not search — do not present remembered facts as search results.'
    );
  },
});
