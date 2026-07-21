// Import side-effects register every tool in the registry.
import './brain.js';
import './memory.js';
import './messaging.js';
import './tasks.js';
import './files.js';
import './code.js';
import './coding.js';
import './email.js';
import './web.js';
import './workflows.js';
import './documents.js';
import './plans.js';
import './questions.js';
import './self.js';

export * from './registry.js';

// The baseline every agent gets: Brain + memory + messaging + tasks + files +
// the self/ask tools. Role-specific kit (email, documents, workflows, code,
// search) is added per template in db/seed.ts — see BASE/EMAIL/DOCS/FLOW there.
// Keeping this lean matters: every name here is a full JSON schema shipped on
// every request the agent makes.
export const DEFAULT_TOOLS = [
  'read_brain_note',
  'write_brain_note',
  'search_brain',
  'save_memory',
  'recall_memory',
  'search_memory',
  'send_channel_message',
  'send_dm',
  'create_task',
  'update_task',
  'create_file',
  'read_file',
  'flag_important',
  'ask_question',
  'describe_self',
  'request_capability',
  'propose_self_improvement',
];

// Role kits, composed into templates in db/seed.ts.
export const EMAIL_TOOLS = ['list_emails', 'search_emails', 'read_email', 'email_folders', 'sort_email', 'draft_email', 'send_email'];
export const DOC_TOOLS = ['create_document', 'edit_document'];
export const FLOW_TOOLS = ['create_workflow', 'list_workflows', 'run_workflow'];
export const PLAN_TOOLS = ['create_plan', 'update_plan_step'];

// Every registered tool name (for the agent creator UI).
export const ALL_TOOL_NAMES = [
  ...DEFAULT_TOOLS,
  ...EMAIL_TOOLS,
  ...DOC_TOOLS,
  ...FLOW_TOOLS,
  ...PLAN_TOOLS,
  'web_search',
  'run_code',
];
