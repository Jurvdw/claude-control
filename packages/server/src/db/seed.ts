import { prisma } from '../lib/prisma.js';
import { DEFAULT_TOOLS, EMAIL_TOOLS, DOC_TOOLS, FLOW_TOOLS, PLAN_TOOLS } from '../tools/index.js';

// Six starter agent templates for the agent creator. Idempotent (upsert by key).

const avatar = (seed: string) => `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(seed)}`;

interface TemplateSeed {
  key: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelClass: 'HAIKU' | 'SONNET' | 'OPUS';
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
  enabledTools: string[];
  isManager?: boolean;
  roleColor: string;
}

const TEMPLATES: TemplateSeed[] = [
  {
    key: 'manager',
    name: 'Manager',
    description: 'Decomposes tasks, assigns agents, and keeps the Brain accurate.',
    systemPrompt:
      'You are the Manager of this server. When given a task, decompose it, pick the right agents, sequence their work by @mentioning them, collect their results, and post a consolidated report. Periodically reconcile agent summaries into the shared Brain. Be decisive and concise.',
    modelClass: 'OPUS',
    effort: 'HIGH',
    // DEFAULT_TOOLS already includes create_task/update_task. web_search is a
    // capability flag (native server-side search) — the Manager fields most
    // "look this up" asks directly, so it gets it too, not just the Researcher.
    // The Manager coordinates everything, so it alone carries the full kit —
    // including email. A new workspace seeds ONLY a Manager, so leaving email
    // to the Email Writer made "send an email" impossible out of the box: the
    // Manager just answered "I don't have a draft_email tool" (found in
    // testing). Worth ~742 tok/call for the default agent to be able to act.
    enabledTools: [...DEFAULT_TOOLS, ...PLAN_TOOLS, ...FLOW_TOOLS, ...DOC_TOOLS, ...EMAIL_TOOLS, 'web_search'],
    isManager: true,
    roleColor: '#d97757',
  },
  {
    key: 'researcher',
    name: 'Researcher',
    description: 'Gathers, cross-checks, and summarizes information.',
    systemPrompt:
      'You are a meticulous researcher. Gather relevant facts, cross-check claims, cite sources, and write tight summaries into the Brain. Prefer accuracy over speed; flag uncertainty explicitly.',
    modelClass: 'SONNET',
    effort: 'MEDIUM',
    // Reads and writes the Brain, searches the web. No workflow/doc/email kit.
    enabledTools: [...DEFAULT_TOOLS, 'web_search'],
    roleColor: '#6ea8fe',
  },
  {
    key: 'coder',
    name: 'Coder',
    description: 'Writes, reviews, and runs code.',
    systemPrompt:
      'You are a pragmatic software engineer. Write clean, correct code, explain trade-offs briefly, and keep changes minimal. Post a short summary plus a file card for code you produce.',
    modelClass: 'SONNET',
    effort: 'HIGH',
    enabledTools: [...DEFAULT_TOOLS, ...DOC_TOOLS, 'run_code'],
    roleColor: '#63e6be',
  },
  {
    key: 'email-writer',
    name: 'Email Writer',
    description: "Drafts emails in the user's voice.",
    systemPrompt:
      "You draft and send emails in the Commander's voice, learned from the Brain note Style/Voice — read it before drafting anything substantial, and match the tone, phrasing and formatting habits recorded there. You can read, search, and sort the connected mailbox freely. To send anything, call draft_email — it puts an editable card in the chat where the Commander previews the sender, recipient, subject and body, edits it inline, asks you for changes, or sends it. Do not paste the email into a chat message as well; the card IS the draft. Never invent a recipient address; if you are unsure who it goes to, use ask_question.",
    modelClass: 'SONNET',
    effort: 'MEDIUM',
    enabledTools: [...DEFAULT_TOOLS, ...EMAIL_TOOLS],
    roleColor: '#ffa94d',
  },
  {
    key: 'note-keeper',
    name: 'Note Keeper',
    description: 'Maintains the Brain: tidy notes, summaries, study material.',
    systemPrompt:
      'You keep the shared Brain organized and accurate. Turn conversations and documents into well-structured markdown notes with one-line summaries. Keep the index clean; avoid duplication.',
    modelClass: 'HAIKU',
    effort: 'LOW',
    enabledTools: DEFAULT_TOOLS,
    roleColor: '#b197fc',
  },
  {
    key: 'designer',
    name: 'Designer',
    description: 'Handles design tasks and visual direction.',
    systemPrompt:
      'You are a thoughtful product/visual designer. Propose distinct directions with concrete specs (palette, type, layout) before building. Avoid generic AI aesthetics; aim for intentional, cohesive design.',
    modelClass: 'SONNET',
    effort: 'MEDIUM',
    enabledTools: DEFAULT_TOOLS,
    roleColor: '#f783ac',
  },
];

// Tools every agent should have regardless of role. Granted additively on boot
// to agents created before they existed (never removing user customisation).
//
// Deliberately SMALL. This used to carry workflow + document + all 7 email
// tools, so every agent — Note Keeper, Designer, everyone — shipped ~1.5k
// tokens of schemas per call for tools they never touch. Role-specific tools
// now live in the templates below instead.
const CORE_ADDITIONS = [
  'flag_important',
  'ask_question',
  'describe_self',
  'request_capability',
  'propose_self_improvement',
];

export async function reconcileAgentTools(): Promise<void> {
  const agents = await prisma.agent.findMany({ select: { id: true, enabledTools: true } });
  for (const a of agents) {
    const current = Array.isArray(a.enabledTools) ? (a.enabledTools as string[]) : [];
    const missing = CORE_ADDITIONS.filter((t) => !current.includes(t));
    if (missing.length === 0) continue;
    await prisma.agent.update({ where: { id: a.id }, data: { enabledTools: [...current, ...missing] } });
  }
}

export async function ensureSeed(): Promise<void> {
  for (const t of TEMPLATES) {
    await prisma.agentTemplate.upsert({
      where: { key: t.key },
      update: {
        name: t.name,
        description: t.description,
        systemPrompt: t.systemPrompt,
        modelClass: t.modelClass,
        effort: t.effort,
        enabledTools: t.enabledTools,
        isManager: t.isManager ?? false,
        roleColor: t.roleColor,
        avatarUrl: avatar(t.name),
      },
      create: {
        key: t.key,
        name: t.name,
        description: t.description,
        systemPrompt: t.systemPrompt,
        modelClass: t.modelClass,
        effort: t.effort,
        enabledTools: t.enabledTools,
        isManager: t.isManager ?? false,
        roleColor: t.roleColor,
        avatarUrl: avatar(t.name),
      },
    });
  }
}
