# Real Coding Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents genuine Claude Code capability — real file read/write/edit and shell access scoped to a real folder on disk — for both subscription-mode and API-key-mode agents, via six new tools layered onto the app's existing per-agent tool system.

**Architecture:** A new workspace-level `Server.settings.projectDir` setting (validated against the same filesystem fence that already protects the app's own install), a native folder picker wired through Electron's IPC bridge, six new canonical tool names (`project_read_file`, `project_list_dir`, `project_search`, `project_write_file`, `project_edit_file`, `project_run_bash`) registered in the existing tool registry for API-key mode, and a small translation layer in subscription mode that maps those same six names onto the Claude Agent SDK's own built-in Read/Glob/Grep/Write/Edit/Bash tools.

**Tech Stack:** TypeScript, Express, Prisma (PostgreSQL), `node:fs/promises`, `node:child_process`, `@anthropic-ai/claude-agent-sdk`, React/TypeScript, Electron (`dialog`, IPC), Vitest.

## Global Constraints

- No Prisma migration files — this plan needs no schema change at all (`projectDir` lives inside `Server.settings Json`, `Agent.enabledTools Json` already holds arbitrary tool names).
- Zero route-level (supertest-style) backend tests in this codebase — test pure functions with mocked dependencies only, matching every existing file in `packages/server/tests/`.
- Zero automated tests in `packages/web` — verify with `npm run build -w @cc/web` (typecheck) plus manual checks.
- Windows-only app (win32-x64) — no cross-platform shell handling needed for `project_run_bash`.
- The six new tool names are `project_read_file`, `project_list_dir`, `project_search`, `project_write_file`, `project_edit_file`, `project_run_bash` — exactly these, not the more obvious `read_file`/`write_file` (those collide with the existing DB-file tools in `tools/files.ts`).
- None of the six tools set `requiresApproval` — deliberate, per the design's "free within the folder" decision. The existing per-agent `requiresApproval` toggle and per-workspace `approvalActions` list still apply if a user opts an agent into them — that's unrelated existing behavior, not something this plan changes.
- `project_run_bash` uses `spawn(command, { shell: true, cwd: projectDir })` — `shell: true` is correct and required here, not a vulnerability (see design spec §5).

---

### Task 1: Project directory validation + workspace settings wiring

**Files:**
- Modify: `packages/server/src/lib/mcpFence.ts`
- Modify: `packages/server/src/routes/servers.ts:142-169` (the PATCH handler)
- Modify: `packages/server/tests/mcpFence.test.ts`
- Modify: `packages/web/src/lib/types.ts` (the `ServerSettings` interface, currently lines 20-27)

**Interfaces:**
- Produces: `checkProjectDir(dir: string): string | null` (exported from `mcpFence.ts`) — returns an error message if `dir` resolves inside or around a protected root, else `null`. Later tasks don't call this directly (only the route does), but Task 3's UI surfaces whatever error the route returns.
- Produces: `ServerSettings.projectDir?: string` — consumed by Task 3 (settings UI) and read server-side via `Server.settings` in Tasks 4 and 5.

- [ ] **Step 1: Export the fence primitives and add `checkProjectDir`**

Open `packages/server/src/lib/mcpFence.ts`. Change the `protectedRoots` and `contains` function declarations (currently private) to exported, and add `checkProjectDir` after `checkMcpPaths`:

```ts
// change these two declarations (keep their bodies exactly as-is):
export function protectedRoots(): string[] {
  // ...unchanged body...
}

export function contains(parent: string, child: string): boolean {
  // ...unchanged body...
}
```

Then append this new function at the end of the file:

```ts
/**
 * Returns an error message if `dir` would put a workspace's project folder
 * inside (or around) the app's own install/source/data directory, else null.
 * Same threat model as checkMcpPaths, applied to a plain directory path
 * instead of an MCP server's command/args/env.
 */
export function checkProjectDir(dir: string): string | null {
  let resolved: string;
  try {
    resolved = path.resolve(dir);
  } catch {
    return `"${dir}" is not a valid path.`;
  }
  for (const root of protectedRoots()) {
    if (contains(root, resolved) || contains(resolved, root)) {
      return `That folder (${dir}) would give agents access to Claude Control's own files. Pick a project folder outside the app.`;
    }
  }
  return null;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/server/tests/mcpFence.test.ts` (add the import alongside the existing one, and a new `describe` block at the end of the file):

```ts
import { checkMcpPaths, checkProjectDir } from '../src/lib/mcpFence.js';
```

```ts
describe('checkProjectDir', () => {
  it('allows an unrelated folder', () => {
    expect(checkProjectDir(path.join('C:', 'Users', 'someone', 'code', 'myproject'))).toBeNull();
  });

  it('blocks the app source directory', () => {
    expect(checkProjectDir(serverRoot)).toMatch(/Claude Control/);
  });

  it('blocks a nested path inside the app', () => {
    expect(checkProjectDir(path.join(serverRoot, 'src', 'tools'))).toMatch(/Claude Control/);
  });

  it('blocks an ancestor of the app (a broad root)', () => {
    expect(checkProjectDir(path.parse(serverRoot).root)).toMatch(/Claude Control/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @cc/server -- mcpFence`
Expected: FAIL — `checkProjectDir` is not exported (or not defined) yet.

- [ ] **Step 4: Run the tests again after Step 1's implementation**

Run: `npm test -w @cc/server -- mcpFence`
Expected: all tests in `mcpFence.test.ts` PASS (the 6 existing `checkMcpPaths` tests plus the 4 new `checkProjectDir` tests).

- [ ] **Step 5: Wire the check into `PATCH /servers/:serverId`**

In `packages/server/src/routes/servers.ts`, add the import and the check. Change the top import line:

```ts
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { checkProjectDir } from '../lib/mcpFence.js';
```

Change the PATCH handler (currently lines 142-169) to check `body.data.settings.projectDir` when present, before the `prisma.server.update` call:

```ts
serversRouter.patch(
  '/:serverId',
  requireServerMember(MemberRole.ADMIN),
  async (req, res, next) => {
    try {
      const body = patchServerSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid body' });

      const nextProjectDir = body.data.settings?.projectDir;
      if (typeof nextProjectDir === 'string' && nextProjectDir.trim()) {
        const fenceError = checkProjectDir(nextProjectDir);
        if (fenceError) return res.status(400).json({ error: fenceError });
      }

      const server = await prisma.server.findUnique({ where: { id: req.params.serverId } });
      if (!server) return res.status(404).json({ error: 'not found' });

      const updated = await prisma.server.update({
        where: { id: req.params.serverId },
        data: {
          ...(body.data.name && { name: body.data.name }),
          ...(body.data.description !== undefined && { description: body.data.description }),
          ...(body.data.settings && {
            settings: { ...(server.settings as object), ...body.data.settings } as Prisma.InputJsonValue,
          }),
        },
      });

      return res.json({ server: updated });
    } catch (err) {
      next(err);
    }
  },
);
```

This codebase has no route-level tests (see Global Constraints), so this wiring isn't separately unit-tested — the same precedent as `mcp.ts`'s own `checkMcpPaths` call, which also isn't route-tested. `checkProjectDir` itself is fully covered by Step 2's tests.

- [ ] **Step 6: Add `projectDir` to the frontend's `ServerSettings` type**

In `packages/web/src/lib/types.ts`, change the `ServerSettings` interface (currently lines 20-27):

```ts
export interface ServerSettings {
  brainWritePolicy: BrainWritePolicy;
  approvalMode: boolean;
  approvalActions: string[];
  hopLimit: number;
  maxConcurrent: number;
  proactiveDefault: boolean;
  projectDir?: string;
}
```

- [ ] **Step 7: Typecheck the frontend**

Run: `npm run build -w @cc/web`
Expected: compiles with no errors (the new optional field doesn't break any existing usage).

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/lib/mcpFence.ts packages/server/src/routes/servers.ts packages/server/tests/mcpFence.test.ts packages/web/src/lib/types.ts
git commit -m "Add checkProjectDir and wire it into PATCH /servers/:serverId"
```

---

### Task 2: Native folder picker (Electron IPC)

**Files:**
- Modify: `packages/desktop/electron/main.cjs`
- Modify: `packages/desktop/electron/preload.cjs`
- Modify: `packages/web/src/components/UpdateWatcher.tsx` (the `Window.ccDesktop` type, currently lines 15-23)

**Interfaces:**
- Produces: `window.ccDesktop.pickFolder(): Promise<string | null>` — consumed by Task 3's settings UI. Resolves to the chosen absolute path, or `null` if the user cancelled the dialog.

- [ ] **Step 1: Add the IPC handler in the main process**

In `packages/desktop/electron/main.cjs`, inside the `app.whenReady().then(() => { ... })` block, alongside the existing `ipcMain.handle('cc:version', ...)` (currently around line 171), add:

```js
  ipcMain.handle('cc:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
```

`dialog` is already imported at the top of this file (`const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');`), so no new import is needed.

- [ ] **Step 2: Expose it through the preload bridge**

In `packages/desktop/electron/preload.cjs`, add a new method to the `contextBridge.exposeInMainWorld('ccDesktop', { ... })` object:

```js
contextBridge.exposeInMainWorld('ccDesktop', {
  version: () => ipcRenderer.invoke('cc:version'),

  /** Subscribe to update lifecycle events. Returns an unsubscribe function. */
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('cc:update', handler);
    return () => ipcRenderer.removeListener('cc:update', handler);
  },

  /** Quit and install a downloaded update now (the user explicitly opted in). */
  installNow: () => ipcRenderer.invoke('cc:install-update'),

  /** Open a native folder picker. Resolves to the chosen path, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke('cc:pick-folder'),
});
```

- [ ] **Step 3: Extend the `ccDesktop` type declaration**

In `packages/web/src/components/UpdateWatcher.tsx`, change the `declare global` block (currently lines 15-23):

```ts
declare global {
  interface Window {
    ccDesktop?: {
      version(): Promise<string>;
      onUpdate(cb: (e: UpdateEvent) => void): () => void;
      installNow(): Promise<void>;
      pickFolder(): Promise<string | null>;
    };
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run build -w @cc/web`
Expected: compiles with no errors.

- [ ] **Step 5: Verify manually**

There is no automated test harness for Electron's main process in this codebase (the same is true of the existing `cc:version`/`cc:install-update` handlers). Verify by running the dev app:

Run: `npm run desktop`

Once Task 3 adds a UI button that calls `pickFolder()`, clicking it should open a native Windows folder-selection dialog. Note in your report that this step is deferred until Task 3 lands (there is no UI to trigger it yet from this task alone) — it's fine to do a lighter sanity check now: confirm `npm run desktop` still starts and the app window loads without a console error, since a typo in `main.cjs` (a `.cjs` file, not typechecked) would only surface at runtime.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/electron/main.cjs packages/desktop/electron/preload.cjs packages/web/src/components/UpdateWatcher.tsx
git commit -m "Add a native folder-picker IPC bridge (cc:pick-folder)"
```

---

### Task 3: Project folder settings UI

**Files:**
- Modify: `packages/web/src/components/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `window.ccDesktop.pickFolder(): Promise<string | null>` (Task 2), `ServerSettings.projectDir?: string` (Task 1), the existing `saveSettings(patch: Partial<ServerSettings>)` function (already defined at `SettingsPanel.tsx:126-138`), and the existing `Section`/`Field` components (already defined at the bottom of the same file).

- [ ] **Step 1: Add a "Coding" section**

In `packages/web/src/components/SettingsPanel.tsx`, add a new section after the existing "Automation" section (which currently ends around line 236, right before `{/* ── Email ─────────────────────────────────────────────────────── */}`):

```tsx
        {/* ── Coding ────────────────────────────────────────────────────── */}
        {settings && <CodingSection settings={settings} saveSettings={saveSettings} />}

        {/* ── Email ─────────────────────────────────────────────────────── */}
        <EmailSection />
```

Then add the `CodingSection` component itself near the other section components at the bottom of the file (alongside `AboutSection`, `EmailSection`, etc.):

```tsx
// Lets a workspace point coding-capable agents (project_read_file,
// project_run_bash, etc.) at a real folder on disk. Folder picking needs the
// native Electron dialog — in a browser tab there's no picker, so the section
// explains that instead of showing a broken button.
function CodingSection({
  settings,
  saveSettings,
}: {
  settings: ServerSettings;
  saveSettings: (patch: Partial<ServerSettings>) => Promise<void>;
}) {
  const { addToast } = useNotifications();
  const [picking, setPicking] = useState(false);

  const choose = async () => {
    if (!window.ccDesktop) return;
    setPicking(true);
    try {
      const dir = await window.ccDesktop.pickFolder();
      if (!dir) return; // user cancelled
      await saveSettings({ projectDir: dir });
    } catch (e) {
      addToast('Could not set project folder', (e as Error).message, 'error');
    } finally {
      setPicking(false);
    }
  };

  return (
    <Section title="Coding" desc="Give agents real file and shell access, scoped to one folder on this machine.">
      {window.ccDesktop ? (
        <Field label="Project folder" desc="Shared by every agent in this workspace with a coding tool enabled (project_read_file, project_run_bash, etc.).">
          <div className="flex items-center gap-2">
            <span className="text-xs text-cream-300 font-mono max-w-[280px] truncate">
              {settings.projectDir || 'Not set'}
            </span>
            <Button type="button" variant="ghost" onClick={choose} disabled={picking}>
              {picking ? 'Choosing…' : 'Choose folder…'}
            </Button>
          </div>
        </Field>
      ) : (
        <p className="text-sm text-ink-500">Setting a project folder requires the desktop app.</p>
      )}
    </Section>
  );
}
```

This uses `useNotifications` and `Button`, both already imported at the top of `SettingsPanel.tsx` (confirm the existing imports include them — they do, per the file's current import list: `import { useNotifications } from '../state/NotificationContext';` and `import { Button, Input } from './ui';`).

- [ ] **Step 2: Typecheck**

Run: `npm run build -w @cc/web`
Expected: compiles with no errors.

- [ ] **Step 3: Verify manually**

Run: `npm run desktop`. Open Settings for a workspace, confirm the new "Coding" section appears with "Not set" and a "Choose folder…" button, click it, pick a folder, and confirm the path appears and persists after reloading the page. Also try picking a folder inside the repo itself (e.g. this very `Claude Control` directory) and confirm it's rejected with the fence's error message via the toast (Task 1's `checkProjectDir`, surfaced through `saveSettings`'s existing `catch` block at `SettingsPanel.tsx:134-136`).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/SettingsPanel.tsx
git commit -m "Add a workspace settings UI for the coding-agent project folder"
```

---

### Task 4: The six API-key-mode coding tools

**Files:**
- Create: `packages/server/src/tools/coding.ts`
- Modify: `packages/server/src/tools/index.ts`
- Test: `packages/server/tests/coding.test.ts`

**Interfaces:**
- Produces: six tools registered by name in the shared registry (`project_read_file`, `project_list_dir`, `project_search`, `project_write_file`, `project_edit_file`, `project_run_bash`), each conforming to the existing `Tool` interface from `packages/server/src/tools/registry.ts:18-28`. Consumed automatically by API-key mode's `executeToolForRun` (`runLoop.ts`) once an agent has one enabled, and by name only (not by import) in Task 5's `CODING_TOOL_MAP`.
- Consumes: `ToolContext` (`registry.ts:6-16`), `registerTool` (`registry.ts:32-34`), `prisma` (`lib/prisma.js`).

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/coding.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { getTool } from '../src/tools/registry.js';
import '../src/tools/coding.js'; // side effect: registers the six tools

let projectDir: string | undefined = 'C:\\proj';
const files = new Map<string, string>(); // absolute path -> content

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    server: {
      findUnique: async () => ({ settings: { projectDir } }),
    },
  },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: async (p: string) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p: string, content: string) => {
      files.set(p, content);
    },
    mkdir: async () => {},
    readdir: async (dir: string) => {
      const seen = new Map<string, boolean>(); // name -> isDirectory
      const prefix = dir.endsWith('\\') ? dir : `${dir}\\`;
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const [first, ...more] = rest.split('\\');
        if (!seen.has(first)) seen.set(first, more.length > 0);
      }
      return [...seen.entries()].map(([name, isDirectory]) => ({ name, isDirectory: () => isDirectory }));
    },
  },
}));

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}
let spawnImpl: (command: string) => FakeChild = () => makeFakeChild();
vi.mock('node:child_process', () => ({ spawn: (command: string) => spawnImpl(command) }));

const ctx = { serverId: 's1', agent: {} as never, ownerUserId: 'u1' } as never;

beforeEach(() => {
  files.clear();
  projectDir = 'C:\\proj';
});

describe('project_read_file', () => {
  it('reads a file within the project folder', async () => {
    files.set('C:\\proj\\a.txt', 'hello');
    const out = await getTool('project_read_file')!.execute({ path: 'a.txt' }, ctx);
    expect(out).toBe('hello');
  });

  it('rejects a path that escapes the project folder', async () => {
    const out = await getTool('project_read_file')!.execute({ path: '..\\..\\secret.txt' }, ctx);
    expect(out).toMatch(/outside the project folder/);
  });

  it('returns a clear error when no project folder is set', async () => {
    projectDir = undefined;
    const out = await getTool('project_read_file')!.execute({ path: 'a.txt' }, ctx);
    expect(out).toMatch(/No project folder set/);
  });
});

describe('project_write_file', () => {
  it('writes a new file', async () => {
    const out = await getTool('project_write_file')!.execute({ path: 'b.txt', content: 'hi' }, ctx);
    expect(out).toMatch(/Wrote/);
    expect(files.get('C:\\proj\\b.txt')).toBe('hi');
  });
});

describe('project_edit_file', () => {
  it('replaces a unique match', async () => {
    files.set('C:\\proj\\c.txt', 'foo bar baz');
    const out = await getTool('project_edit_file')!.execute({ path: 'c.txt', oldText: 'bar', newText: 'QUX' }, ctx);
    expect(out).toMatch(/Edited/);
    expect(files.get('C:\\proj\\c.txt')).toBe('foo QUX baz');
  });

  it('rejects when oldText matches more than once', async () => {
    files.set('C:\\proj\\d.txt', 'x x x');
    const out = await getTool('project_edit_file')!.execute({ path: 'd.txt', oldText: 'x', newText: 'y' }, ctx);
    expect(out).toMatch(/more than once/);
  });

  it('rejects when oldText is not found', async () => {
    files.set('C:\\proj\\e.txt', 'abc');
    const out = await getTool('project_edit_file')!.execute({ path: 'e.txt', oldText: 'zzz', newText: 'y' }, ctx);
    expect(out).toMatch(/not found/);
  });
});

describe('project_list_dir', () => {
  it('lists files and subfolders with forward-slash-normalized paths', async () => {
    files.set('C:\\proj\\a.txt', '');
    files.set('C:\\proj\\sub\\b.txt', '');
    const out = await getTool('project_list_dir')!.execute({}, ctx);
    expect(out).toContain('a.txt');
    expect(out).toContain('sub/');
    expect(out).toContain('sub/b.txt');
  });
});

describe('project_search', () => {
  it('finds a matching line with its file and line number', async () => {
    files.set('C:\\proj\\a.txt', 'line one\nline TWO has target\nline three');
    const out = await getTool('project_search')!.execute({ query: 'target' }, ctx);
    expect(out).toMatch(/a\.txt:2:/);
  });

  it('reports no matches plainly', async () => {
    files.set('C:\\proj\\a.txt', 'nothing here');
    const out = await getTool('project_search')!.execute({ query: 'zzz' }, ctx);
    expect(out).toBe('No matches.');
  });
});

describe('project_run_bash', () => {
  it('captures stdout and exit code', async () => {
    spawnImpl = () => {
      const child = makeFakeChild();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('done\n'));
        child.emit('close', 0);
      }, 0);
      return child;
    };
    const out = await getTool('project_run_bash')!.execute({ command: 'echo done' }, ctx);
    expect(out).toMatch(/done/);
    expect(out).toMatch(/exit code 0/);
  });

  it('reports a non-zero exit code', async () => {
    spawnImpl = () => {
      const child = makeFakeChild();
      setTimeout(() => child.emit('close', 1), 0);
      return child;
    };
    const out = await getTool('project_run_bash')!.execute({ command: 'exit 1' }, ctx);
    expect(out).toMatch(/exit code 1/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @cc/server -- coding`
Expected: FAIL — `../src/tools/coding.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/tools/coding.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prisma } from '../lib/prisma.js';
import { registerTool, type ToolContext } from './registry.js';

const MAX_READ_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 20_000;
const BASH_TIMEOUT_MS = 120_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_LIST_ENTRIES = 500;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);

const NO_PROJECT_DIR =
  'No project folder set for this workspace — set one in workspace settings before using coding tools.';

async function projectDirFor(ctx: ToolContext): Promise<string | null> {
  const server = await prisma.server.findUnique({ where: { id: ctx.serverId }, select: { settings: true } });
  const dir = (server?.settings as { projectDir?: string } | null)?.projectDir;
  return dir && dir.trim() ? dir : null;
}

// Resolve a tool-supplied relative path against the project folder, rejecting
// any path that would escape it (..-traversal or an absolute path elsewhere).
function resolveInProject(projectDir: string, relPath: string): string | null {
  const resolved = path.resolve(projectDir, relPath);
  const rel = path.relative(projectDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

registerTool({
  name: 'project_read_file',
  description: "Read a file's text content from the workspace's project folder. Path is relative to the project root.",
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path, relative to the project folder' } },
    required: ['path'],
  },
  summarize: (input) => `Read ${input.path}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const target = resolveInProject(projectDir, String(input.path));
    if (!target) return `"${input.path}" is outside the project folder.`;
    try {
      const content = await fs.readFile(target, 'utf8');
      return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n… (truncated, ${content.length} chars total)`
        : content;
    } catch (err) {
      return `Could not read "${input.path}": ${(err as Error).message}`;
    }
  },
});

registerTool({
  name: 'project_list_dir',
  description:
    'List files and folders under a path in the workspace\'s project folder (recursive). Optional "filter" narrows to names containing that substring.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list, relative to the project folder. Defaults to the root.' },
      filter: { type: 'string', description: 'Only include entries whose name contains this substring (case-insensitive).' },
    },
  },
  summarize: (input) => `List ${input.path || '.'}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const start = resolveInProject(projectDir, String(input.path ?? '.'));
    if (!start) return `"${input.path}" is outside the project folder.`;
    const filter = input.filter ? String(input.filter).toLowerCase() : undefined;
    const out: string[] = [];

    async function walk(dir: string) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_LIST_ENTRIES) return;
        if (IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        // Normalize to forward slashes — path.relative uses the OS separator
        // (backslash on Windows), which would otherwise mix with the literal
        // "/" suffix below and read inconsistently.
        const rel = path.relative(projectDir!, full).split(path.sep).join('/');
        if (!filter || e.name.toLowerCase().includes(filter)) out.push(e.isDirectory() ? `${rel}/` : rel);
        if (e.isDirectory()) await walk(full);
      }
    }
    await walk(start);
    if (out.length === 0) return '(empty)';
    return out.join('\n') + (out.length >= MAX_LIST_ENTRIES ? `\n… (truncated at ${MAX_LIST_ENTRIES} entries)` : '');
  },
});

registerTool({
  name: 'project_search',
  description:
    'Search file contents in the workspace\'s project folder for a substring, like grep. Returns matching "path:line: text" entries.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for (case-insensitive substring match)' },
      path: { type: 'string', description: 'Directory to search under, relative to the project folder. Defaults to the root.' },
    },
    required: ['query'],
  },
  summarize: (input) => `Search for "${input.query}"`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const start = resolveInProject(projectDir, String(input.path ?? '.'));
    if (!start) return `"${input.path}" is outside the project folder.`;
    const query = String(input.query).toLowerCase();
    const matches: string[] = [];

    async function walk(dir: string) {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        if (IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
          continue;
        }
        let text: string;
        try {
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue; // binary or unreadable — skip
        }
        const rel = path.relative(projectDir!, full).split(path.sep).join('/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          if (lines[i].toLowerCase().includes(query)) matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    await walk(start);
    if (matches.length === 0) return 'No matches.';
    return matches.join('\n') + (matches.length >= MAX_SEARCH_MATCHES ? `\n… (truncated at ${MAX_SEARCH_MATCHES} matches)` : '');
  },
});

registerTool({
  name: 'project_write_file',
  description: "Create or overwrite a file in the workspace's project folder. Path is relative to the project root.",
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project folder' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  summarize: (input) => `Write ${input.path}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const target = resolveInProject(projectDir, String(input.path));
    if (!target) return `"${input.path}" is outside the project folder.`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(input.content), 'utf8');
      return `Wrote ${Buffer.byteLength(String(input.content), 'utf8')} bytes to ${input.path}.`;
    } catch (err) {
      return `Could not write "${input.path}": ${(err as Error).message}`;
    }
  },
});

registerTool({
  name: 'project_edit_file',
  description:
    'Replace an exact block of text in a file within the workspace\'s project folder. oldText must match exactly once; use project_read_file first to get exact text.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project folder' },
      oldText: { type: 'string', description: 'Exact text to replace — must occur exactly once in the file' },
      newText: { type: 'string' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  summarize: (input) => `Edit ${input.path}`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const target = resolveInProject(projectDir, String(input.path));
    if (!target) return `"${input.path}" is outside the project folder.`;
    let content: string;
    try {
      content = await fs.readFile(target, 'utf8');
    } catch (err) {
      return `Could not read "${input.path}": ${(err as Error).message}`;
    }
    const oldText = String(input.oldText);
    const first = content.indexOf(oldText);
    if (first === -1) return `oldText not found in "${input.path}" — read the file first to get exact text.`;
    const second = content.indexOf(oldText, first + oldText.length);
    if (second !== -1) return `oldText matches more than once in "${input.path}" — include more surrounding context to make it unique.`;
    const updated = content.slice(0, first) + String(input.newText) + content.slice(first + oldText.length);
    await fs.writeFile(target, updated, 'utf8');
    return `Edited "${input.path}".`;
  },
});

registerTool({
  name: 'project_run_bash',
  description: "Run a shell command in the workspace's project folder and return its output.",
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  summarize: (input) => `Run: ${String(input.command).slice(0, 60)}…`,
  async execute(input, ctx) {
    const projectDir = await projectDirFor(ctx);
    if (!projectDir) return NO_PROJECT_DIR;
    const command = String(input.command);
    return new Promise<string>((resolve) => {
      const child = spawn(command, { shell: true, cwd: projectDir });
      let out = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, BASH_TIMEOUT_MS);
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { out += d.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const capped = out.length > MAX_OUTPUT_CHARS ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : out;
        if (timedOut) resolve(`${capped}\n(command timed out after ${BASH_TIMEOUT_MS / 1000}s and was killed)`);
        else resolve(`${capped}\n(exit code ${code})`);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(`Failed to run command: ${err.message}`);
      });
    });
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @cc/server -- coding`
Expected: all tests in `coding.test.ts` PASS.

- [ ] **Step 5: Register the module's side effects**

In `packages/server/src/tools/index.ts`, add the import alongside the others:

```ts
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
```

- [ ] **Step 6: Run the full backend test suite**

Run: `npm test -w @cc/server`
Expected: all tests pass (the pre-existing suite plus the new `coding.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/tools/coding.ts packages/server/src/tools/index.ts packages/server/tests/coding.test.ts
git commit -m "Add six real coding tools (project_read_file, project_write_file, project_edit_file, project_list_dir, project_search, project_run_bash)"
```

---

### Task 5: Subscription-mode wiring

**Files:**
- Modify: `packages/server/src/llm/types.ts` (the `AgenticRunParams` interface, currently lines 58-69)
- Modify: `packages/server/src/llm/subscription.ts`
- Modify: `packages/server/src/agents/runLoop.ts` (the `provider.runAgentic(...)` call, currently around lines 120-133)
- Test: `packages/server/tests/coding-builtins.test.ts`

**Interfaces:**
- Consumes: the same six canonical tool names Task 4 registers (referenced here only as string literals — no import from `coding.ts`, matching how `subscription.ts` already checks for `'web_search'` by name only).
- Produces: `AgenticRunParams.projectDir?: string`, `codingBuiltinsFor(toolNames: string[]): string[]` (exported from `subscription.ts` for the test).

- [ ] **Step 1: Add `projectDir` to `AgenticRunParams`**

In `packages/server/src/llm/types.ts`, change the interface (currently lines 58-69):

```ts
export interface AgenticRunParams {
  system: string;
  prompt: string;
  modelClass: AgentModelClass;
  effort: AgentEffort;
  tools: LLMToolSpec[];
  // Execute one of our registered tools (with approval/context already wired).
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  maxTurns?: number;
  // External MCP servers to mount ({ name → SDK config }); subscription mode only.
  mcpServers?: Record<string, unknown>;
  // Workspace's project folder (Server.settings.projectDir); subscription mode
  // only. Enables the SDK's own Read/Write/Edit/Glob/Grep/Bash for agents with
  // the matching project_* tool enabled — see subscription.ts's
  // codingBuiltinsFor. Unset ⇒ no coding tools, regardless of what the agent
  // has enabled.
  projectDir?: string;
}
```

- [ ] **Step 2: Write the failing test for the pure mapping function**

Create `packages/server/tests/coding-builtins.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { __testing } from '../src/llm/subscription.js';

const { codingBuiltinsFor } = __testing;

describe('codingBuiltinsFor', () => {
  it('maps each canonical coding tool name to its SDK built-in', () => {
    expect(codingBuiltinsFor(['project_read_file'])).toEqual(['Read']);
    expect(codingBuiltinsFor(['project_list_dir'])).toEqual(['Glob']);
    expect(codingBuiltinsFor(['project_search'])).toEqual(['Grep']);
    expect(codingBuiltinsFor(['project_write_file'])).toEqual(['Write']);
    expect(codingBuiltinsFor(['project_edit_file'])).toEqual(['Edit']);
    expect(codingBuiltinsFor(['project_run_bash'])).toEqual(['Bash']);
  });

  it('ignores non-coding tool names', () => {
    expect(codingBuiltinsFor(['send_email', 'web_search'])).toEqual([]);
  });

  it('handles a mixed list, preserving only the coding tools', () => {
    expect(codingBuiltinsFor(['project_read_file', 'send_email', 'project_run_bash'])).toEqual(['Read', 'Bash']);
  });

  it('returns an empty array for an empty list', () => {
    expect(codingBuiltinsFor([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @cc/server -- coding-builtins`
Expected: FAIL — `codingBuiltinsFor` is not exported from `subscription.ts`'s `__testing` yet.

- [ ] **Step 4: Implement the mapping and wire it into `runAgentic`**

In `packages/server/src/llm/subscription.ts`, add the map and function near the top of the file (after the existing `MCP_NAME` constant):

```ts
const MCP_NAME = 'cc';

// Canonical tool name (see tools/coding.ts) → the Claude Agent SDK's matching
// built-in. Only meaningful when a workspace has a project folder set — see
// runAgentic below.
const CODING_TOOL_MAP: Record<string, string> = {
  project_read_file: 'Read',
  project_list_dir: 'Glob',
  project_search: 'Grep',
  project_write_file: 'Write',
  project_edit_file: 'Edit',
  project_run_bash: 'Bash',
};

function codingBuiltinsFor(toolNames: string[]): string[] {
  const out: string[] = [];
  for (const n of toolNames) {
    const builtin = CODING_TOOL_MAP[n];
    if (builtin) out.push(builtin);
  }
  return out;
}
```

Then change `runAgentic`'s body (currently lines 87-152) to exclude the six canonical names from `ourTools` (they're never exposed as our own `mcp__` tools — only ever translated to SDK built-ins), compute `codingBuiltins`, and extend `tools`/`cwd`/`canUseTool`:

```ts
  async runAgentic(params: AgenticRunParams, onEvent?: (e: LLMStreamEvent) => void): Promise<LLMResult> {
    this.applyAuth();

    // `web_search` in our registry is a capability flag, not a real client-side
    // tool: it switches on the SDK's native WebSearch (which runs server-side).
    // We drop our stub so the model sees exactly one search tool. The six
    // project_* coding tools are handled the same way, in favor of the SDK's
    // own built-ins — see codingBuiltinsFor.
    const wantsWebSearch = params.tools.some((t) => t.name === 'web_search');
    const codingBuiltins = params.projectDir ? codingBuiltinsFor(params.tools.map((t) => t.name)) : [];
    const ourTools = params.tools.filter((t) => t.name !== 'web_search' && !(t.name in CODING_TOOL_MAP));

    // Map our tools onto SDK in-process MCP tools.
    const sdkTools = ourTools.map((spec) =>
      tool(
        spec.name,
        spec.description,
        jsonSchemaToZodShape(spec.input_schema),
        async (input: Record<string, unknown>) => {
          onEvent?.({ type: 'tool_use', id: '', name: spec.name, input });
          const out = await params.executeTool(spec.name, input);
          return { content: [{ type: 'text' as const, text: out }] };
        },
      ),
    );
    const server = createSdkMcpServer({ name: MCP_NAME, version: '1.0.0', tools: sdkTools });
    const allowed = ourTools.map((t) => `mcp__${MCP_NAME}__${t.name}`);
    if (wantsWebSearch) allowed.push('WebSearch');
    // Mount external MCP servers alongside our in-process one.
    const externalMcp = (params.mcpServers ?? {}) as Record<string, McpServerConfig>;

    const model = SUB_MODEL[params.modelClass];
    let lastRateLimit: SDKRateLimitInfo | undefined;
    let text = '';
    let costUsd = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const turnUsage: Array<{ in: number; out: number; cacheR: number; cacheW: number }> = [];

    try {
      const q = query({
        prompt: params.prompt,
        options: {
          model,
          systemPrompt: params.system,
          mcpServers: { [MCP_NAME]: server, ...externalMcp },
          allowedTools: allowed,
          // Drop the SDK's built-in toolset (Read/Write/Edit/Bash/Glob/Grep/
          // Task/TodoWrite/…) UNLESS the workspace has a project folder set and
          // the agent has the matching project_* tool enabled — in which case
          // ship exactly those built-ins (codingBuiltins) and no others.
          // canUseTool already denies anything not explicitly listed here, but
          // an unused built-in's schema still costs real tokens on every
          // request — measured at the bulk of a ~14k-token per-call overhead.
          tools: [...(wantsWebSearch ? ['WebSearch'] : []), ...codingBuiltins],
          cwd: codingBuiltins.length ? params.projectDir : undefined,
          // Permit our tools + any mounted MCP server's tools (all mcp__ prefixed)
          // + WebSearch (if granted) + the coding built-ins translated above.
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>) =>
            toolName.startsWith('mcp__') || (wantsWebSearch && toolName === 'WebSearch') || codingBuiltins.includes(toolName)
              ? { behavior: 'allow' as const, updatedInput: toolInput }
              : { behavior: 'deny' as const, message: 'Only Claude Control + mounted MCP tools are permitted.' },
          settingSources: [],
          // Skills are a Claude Code feature our agents never use — they work
          // through our own MCP tools. Omitting this option does NOT disable
          // them (the CLI's defaults still apply and their listing rides in the
          // prompt), so turn them off explicitly.
          skills: [],
          maxTurns: params.maxTurns ?? 8,
          effort: SUB_EFFORT[params.effort],
        },
      });
```

The rest of `runAgentic` (the `for await` loop and everything after it) is unchanged.

- [ ] **Step 5: Export `codingBuiltinsFor` for the test**

At the bottom of `packages/server/src/llm/subscription.ts`, change the existing `__testing` export:

```ts
// Exposed for tests: the JSON-schema -> zod conversion is easy to break in ways
// that only show up as a model silently receiving the wrong tool shape, and
// codingBuiltinsFor is easy to break in ways that only show up as an agent
// silently missing (or wrongly gaining) a built-in tool.
export const __testing = { jsonSchemaToZodShape, mapType, codingBuiltinsFor };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -w @cc/server -- coding-builtins`
Expected: all 4 tests PASS.

- [ ] **Step 7: Pass `projectDir` through from the run loop**

In `packages/server/src/agents/runLoop.ts`, change the `provider.runAgentic(...)` call (currently around lines 120-133) to add `projectDir`:

```ts
      const result = await provider.runAgentic(
        {
          system: ctx.system,
          prompt,
          modelClass: profile.modelClass,
          effort: profile.effort,
          tools: toolSpecs,
          executeTool: (name, input) => {
            toolsUsed.add(name);
            return executeToolForRun(name, input, agent, server, run.id, trigger);
          },
          maxTurns: ITERATION_CAP,
          mcpServers,
          projectDir: (server.settings as { projectDir?: string } | null)?.projectDir,
        },
        (e) => {
```

The rest of the call (the event callback and everything after) is unchanged.

- [ ] **Step 8: Run the full backend test suite**

Run: `npm test -w @cc/server`
Expected: all tests pass, including the pre-existing `schema-conversion.test.ts` (which also imports `subscription.ts`'s `__testing` — confirms the export change didn't break its existing usage).

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/llm/types.ts packages/server/src/llm/subscription.ts packages/server/src/agents/runLoop.ts packages/server/tests/coding-builtins.test.ts
git commit -m "Translate the six coding tools into the Agent SDK's own built-ins for subscription-mode agents"
```

---

### Task 6: Update the Coder template

**Files:**
- Modify: `packages/server/src/db/seed.ts` (the `coder` template, currently around lines 53-63)

**Interfaces:**
- Consumes: the six tool names from Task 4 (string literals only — `seed.ts` doesn't import `tools/coding.ts`, matching how it already references `'run_code'` by name only).

- [ ] **Step 1: Update the template**

In `packages/server/src/db/seed.ts`, change the `coder` template entry:

```ts
  {
    key: 'coder',
    name: 'Coder',
    description: 'Writes, reviews, and runs code.',
    systemPrompt:
      'You are a pragmatic software engineer. Write clean, correct code, explain trade-offs briefly, and keep changes minimal. Post a short summary plus a file card for code you produce.',
    modelClass: 'SONNET',
    effort: 'HIGH',
    enabledTools: [
      ...DEFAULT_TOOLS,
      'project_read_file',
      'project_list_dir',
      'project_search',
      'project_write_file',
      'project_edit_file',
      'project_run_bash',
    ],
    roleColor: '#63e6be',
  },
```

This only changes what future newly-created workspaces seed their Coder template with (per `servers.ts`'s existing `tx.agentTemplate.findFirst` / seeded-on-first-boot pattern) — it does not touch any already-created `Agent` row's `enabledTools`, and it does not touch the `AgentTemplate` row already sitting in an existing installed app's database (that row was written once, on first boot, by this same seed data; changing the seed source only affects a fresh database, not an existing one — that matches this plan's Task 3 UI, which is opt-in per agent regardless of template).

- [ ] **Step 2: Typecheck the backend**

Run: `npm run build -w @cc/server`
Expected: compiles with no errors.

- [ ] **Step 3: Run the full backend test suite**

Run: `npm test -w @cc/server`
Expected: all tests still pass (no test asserts the Coder template's exact tool list, so this is a sanity check that nothing else broke).

- [ ] **Step 4: Verify manually**

Run: `npm run desktop` against a **fresh** database (or inspect via a disposable second instance per this codebase's established pattern — see `[[testing-against-live-db]]` in memory) — register a new account, create a workspace, open "New agent," pick the "Coder" template, and confirm the tool checklist shows the six `project_*` tools checked instead of `run_code`/`create_document`/`edit_document`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/seed.ts
git commit -m "Update the Coder template to use the six real coding tools"
```

---

## Full-feature manual verification (after all 6 tasks)

Automated tests cover the fence, the six API-key-mode tools' logic, and the subscription-mode tool-name translation — they cannot cover an actual live SDK round-trip (same limitation as `run_code`/`send_email`/the setup-token flow elsewhere in this codebase). Once all tasks are complete:

1. Set a workspace's project folder to some real, disposable test folder (not this repo).
2. Create an agent with all six `project_*` tools enabled, on a **subscription-mode** workspace. `@mention` it and ask it to create a small file, read it back, edit it, and run a trivial shell command (e.g. `echo hello`). Confirm each step actually touches the real folder on disk.
3. Repeat step 2 on an **API-key-mode** workspace.
4. Confirm a workspace with no project folder set produces a clear "no project folder" message rather than a crash or a silently-ignored tool call, in both modes.
5. Confirm setting the project folder to a path inside this Claude Control repo itself is rejected by the settings UI with the fence's error message.
