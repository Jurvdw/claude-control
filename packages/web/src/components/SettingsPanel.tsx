import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useServer } from '../state/ServerContext';
import { useNotifications } from '../state/NotificationContext';
import { apiKeys as keysApi, servers as serversApi, workspace as workspaceApi, hooks as hooksApi, email as emailApi, mcp as mcpApi } from '../lib/api';
import type { WebhookInfo, TunnelStatus, EmailStatus, McpServerView } from '../lib/api';
import { MCP_CATALOG, type McpCatalogEntry } from '../lib/mcpCatalog';
import type { ProviderStatus, ApiKey, ServerSettings, BrainWritePolicy } from '../lib/types';
import { Button, Input } from './ui';

type ConnectTab = 'apikey' | 'subscription';

// Fallbacks so a workspace whose stored settings predate a field never renders
// blank/NaN controls.
const SETTINGS_DEFAULTS: ServerSettings = {
  brainWritePolicy: 'propose',
  approvalMode: false,
  approvalActions: [],
  hopLimit: 4,
  maxConcurrent: 5,
  proactiveDefault: false,
};

export default function SettingsPanel() {
  const { activeServer, refreshServers } = useServer();
  const { addToast } = useNotifications();

  const exportWorkspace = async () => {
    if (!activeServer) return;
    try {
      const data = await workspaceApi.export(activeServer.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeServer.name.replace(/[^\w.-]+/g, '_')}-backup.json`;
      a.click();
      URL.revokeObjectURL(url);
      addToast('Backup downloaded', undefined, 'success');
    } catch (e) {
      addToast('Export failed', (e as Error).message, 'error');
    }
  };

  const importWorkspace = (file: File) => {
    if (!activeServer) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(String(reader.result));
        const { imported } = await workspaceApi.import(activeServer.id, data);
        const summary = Object.entries(imported).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing new';
        addToast('Restore complete', `Imported ${summary}. Reload to see it.`, 'success');
        await refreshServers();
      } catch (e) {
        addToast('Import failed', (e as Error).message, 'error');
      }
    };
    reader.readAsText(file);
  };

  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [tab, setTab] = useState<ConnectTab>('apikey');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const loadProvider = () => {
    keysApi.providerStatus().then((s) => {
      setStatus(s);
      setTab(s.subscriptionAvailable ? 'subscription' : 'apikey');
    }).catch(() => {});
    keysApi.list().then(({ keys }) => setKeys(keys)).catch(() => {});
  };

  useEffect(loadProvider, []);

  useEffect(() => {
    if (!activeServer) return;
    serversApi.get(activeServer.id).then(({ settings }) => setSettings({ ...SETTINGS_DEFAULTS, ...settings })).catch(() => {});
  }, [activeServer]);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { valid, error } = await keysApi.create(undefined, secret.trim(), tab === 'subscription' ? 'subscription' : 'api');
      if (!valid) { addToast('Validation failed', error || 'That credential was rejected.', 'error'); return; }
      addToast('Connected', tab === 'subscription' ? 'Claude subscription active' : 'API key saved', 'success');
      setSecret('');
      loadProvider();
    } catch (err) {
      addToast('Failed', (err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const useExisting = async () => {
    setBusy(true);
    try {
      const { valid, error } = await keysApi.connectExistingLogin();
      if (!valid) { addToast("Couldn't use Claude login", error || 'Try `claude login`, or paste a setup-token.', 'error'); return; }
      addToast('Connected', 'Using your Claude login', 'success');
      loadProvider();
    } catch (err) {
      addToast('Failed', (err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    try {
      await keysApi.delete(id);
      addToast('Disconnected', undefined, 'info');
      loadProvider();
    } catch (err) {
      addToast('Failed', (err as Error).message, 'error');
    }
  };

  const saveSettings = async (patch: Partial<ServerSettings>) => {
    if (!activeServer || !settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSavingSettings(true);
    try {
      await serversApi.patch(activeServer.id, { settings: next });
      await refreshServers();
    } catch (err) {
      addToast('Failed to save', (err as Error).message, 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-8 space-y-8">
        <h1 className="text-2xl font-semibold text-cream-50">Settings</h1>

        {/* ── Claude connection ─────────────────────────────────────────── */}
        <Section title="Claude connection" desc="How your agents talk to Claude.">
          {status && (
            <div className="flex items-center gap-2 mb-4 text-sm">
              <span className={clsx('w-2 h-2 rounded-full', status.hasKey || status.hasSubscription ? 'bg-emerald-400' : 'bg-ink-500')} />
              <span className="text-cream-200">
                {status.mode === 'subscription' ? 'Claude subscription' : status.hasKey ? 'API key' : 'Not connected'}
              </span>
              {status.selfHosted && <span className="text-[11px] text-ink-500 ml-auto">self-hosted</span>}
            </div>
          )}

          {keys.length > 0 && (
            <div className="space-y-2 mb-5">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center gap-3 bg-ink-800 border border-ink-700 rounded-xl px-4 py-2.5">
                  <span className={clsx('w-2 h-2 rounded-full', k.valid ? 'bg-emerald-400' : 'bg-red-400')} />
                  <span className="text-sm text-cream-200">{k.label || 'Credential'}</span>
                  <span className="text-xs text-ink-500 font-mono">••••{k.last4}</span>
                  <button onClick={() => disconnect(k.id)} className="ml-auto text-xs text-ink-500 hover:text-red-400 transition-colors">Disconnect</button>
                </div>
              ))}
            </div>
          )}

          {/* Connect a new credential */}
          <div className="flex gap-2 mb-3 bg-ink-800 p-1 rounded-xl w-fit">
            {status?.subscriptionAvailable && (
              <TabBtn active={tab === 'subscription'} onClick={() => { setTab('subscription'); setSecret(''); }}>Subscription</TabBtn>
            )}
            <TabBtn active={tab === 'apikey'} onClick={() => { setTab('apikey'); setSecret(''); }}>API key</TabBtn>
          </div>

          <form onSubmit={connect} className="space-y-3">
            {tab === 'subscription' ? (
              <>
                {status?.claudeLoginDetected && (
                  <div className="bg-ink-800 border border-emerald-500/40 rounded-xl p-4">
                    <div className="text-sm text-emerald-300 font-medium">You're signed in with Claude on this machine</div>
                    <p className="text-xs text-cream-400 mt-1">Use your existing login — nothing to paste.</p>
                    <Button type="button" className="mt-3" onClick={useExisting} disabled={busy}>
                      {busy ? 'Connecting…' : 'Use my Claude login'}
                    </Button>
                  </div>
                )}
                <p className="text-sm text-cream-300">Run agents on your Claude Pro / Max / Team plan. Paste a token from <code className="text-clay">claude setup-token</code>.</p>
                <Input type="password" placeholder="sk-ant-oat…" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </>
            ) : (
              <>
                <p className="text-sm text-cream-300">Bring your own Anthropic API key (encrypted at rest, billed pay-per-token).</p>
                <Input type="password" placeholder="sk-ant-…" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </>
            )}
            <Button type="submit" disabled={busy || !secret.trim()}>{busy ? 'Validating…' : 'Connect & validate'}</Button>
          </form>
        </Section>

        {/* ── Automation ────────────────────────────────────────────────── */}
        {settings && (
          <Section title="Automation" desc="How this workspace's agents behave." busy={savingSettings}>
            <Toggle
              label="Require approval for sensitive actions"
              desc="Agents queue risky tool calls for your sign-off instead of running them."
              checked={settings.approvalMode}
              onChange={(v) => saveSettings({ approvalMode: v })}
            />
            <Toggle
              label="Proactive by default"
              desc="New agents may act without being explicitly mentioned."
              checked={settings.proactiveDefault}
              onChange={(v) => saveSettings({ proactiveDefault: v })}
            />
            <Field label="Brain write policy" desc="Whether agents edit the Brain directly or propose changes for review.">
              <select
                value={settings.brainWritePolicy}
                onChange={(e) => saveSettings({ brainWritePolicy: e.target.value as BrainWritePolicy })}
                className="bg-ink-800 text-cream-100 rounded-lg px-3 py-1.5 text-sm border border-ink-700 focus:outline-none focus:border-clay"
              >
                <option value="propose">Propose (review before applying)</option>
                <option value="direct">Direct (write immediately)</option>
              </select>
            </Field>
            <Field label="Mention hop limit" desc="Max chain length when agents @mention each other (prevents runaway loops).">
              <NumberStepper value={settings.hopLimit} min={1} max={10} onChange={(v) => saveSettings({ hopLimit: v })} />
            </Field>
            <Field label="Max concurrent runs" desc="How many agent runs execute at once.">
              <NumberStepper value={settings.maxConcurrent} min={1} max={8} onChange={(v) => saveSettings({ maxConcurrent: v })} />
            </Field>
          </Section>
        )}

        {/* ── Email ─────────────────────────────────────────────────────── */}
        <EmailSection />

        {/* ── MCP servers ───────────────────────────────────────────────── */}
        <McpSection />

        {/* ── Webhooks & tunnel ─────────────────────────────────────────── */}
        <WebhookSection />

        {/* ── Backup ────────────────────────────────────────────────────── */}
        <Section title="Backup & restore" desc="Export or restore this workspace's agents, Brain, workflows, and triggers.">
          <div className="flex items-center gap-3">
            <Button onClick={exportWorkspace}>Export backup</Button>
            <label className="text-sm px-3 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-cream-300 cursor-pointer transition-colors">
              Import backup…
              <input type="file" accept="application/json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importWorkspace(f); e.target.value = ''; }} />
            </label>
          </div>
          <p className="text-xs text-ink-500 mt-2">Import is additive (existing agents/notes are skipped by name). Reload after importing.</p>
        </Section>

        {/* ── About / version ───────────────────────────────────────────── */}
        <AboutSection />
      </div>
    </div>
  );
}

// Version + update state. Only meaningful in the desktop shell; in a browser
// tab there's nothing to update, so the section hides itself.
function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<{ state: string; version?: string; percent?: number } | null>(null);

  useEffect(() => {
    const desktop = window.ccDesktop;
    if (!desktop) return;
    desktop.version().then(setVersion).catch(() => {});
    return desktop.onUpdate((e) => setUpdate(e));
  }, []);

  if (!window.ccDesktop) return null;

  const ready = update?.state === 'ready';
  return (
    <Section title="About" desc="Claude Control checks for updates in the background and installs them when you close the app.">
      <div className="flex items-center gap-3 text-sm">
        <span className="text-ink-400">Version</span>
        <span className="text-cream-100 font-mono">{version ?? '…'}</span>
        {update?.state === 'downloading' && <span className="text-xs text-ink-500">downloading {update.percent}%…</span>}
        {update?.state === 'available' && <span className="text-xs text-clay">update found…</span>}
        {ready && (
          <button
            onClick={() => window.ccDesktop?.installNow()}
            className="text-xs px-3 py-1.5 rounded-lg bg-clay text-white hover:bg-clay-400 transition-colors"
          >
            Restart & install {update?.version}
          </button>
        )}
      </div>
      {ready && <p className="text-xs text-ink-500 mt-2">Or just close the app when you're done — it installs on quit either way.</p>}
    </Section>
  );
}

type TestState = { ok?: boolean; tools?: string[]; error?: string; busy?: boolean };

function McpSection() {
  const { activeServer } = useServer();
  const { addToast } = useNotifications();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  // view: null (list) | 'catalog' | a catalog entry | 'custom'
  const [view, setView] = useState<null | 'catalog' | 'custom' | McpCatalogEntry>(null);

  const refresh = () => { if (activeServer) mcpApi.list(activeServer.id).then(({ servers }) => setServers(servers)).catch(() => {}); };
  useEffect(refresh, [activeServer]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!activeServer) return null;
  const sid = activeServer.id;

  const runTest = async (m: McpServerView) => {
    setTests((t) => ({ ...t, [m.id]: { busy: true } }));
    try {
      const r = await mcpApi.test(sid, m.id);
      setTests((t) => ({ ...t, [m.id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [m.id]: { ok: false, error: (e as Error).message } }));
    }
  };
  const toggle = async (m: McpServerView) => { await mcpApi.patch(sid, m.id, { enabled: !m.enabled }).catch(() => {}); refresh(); };
  const remove = async (m: McpServerView) => { await mcpApi.delete(sid, m.id).catch(() => {}); refresh(); };

  // Create then immediately test, so the user sees "✓ N tools" or a real error.
  const addAndTest = async (body: Parameters<typeof mcpApi.create>[1]) => {
    const { server } = await mcpApi.create(sid, body);
    setView(null);
    refresh();
    addToast('MCP server added', 'Testing the connection…', 'info');
    await runTest(server);
  };

  return (
    <Section title="MCP servers" desc="Give agents new tools by connecting MCP servers — GitHub, Slack, files, databases, and more.">
      {servers.length > 0 && (
        <div className="space-y-2">
          {servers.map((m) => {
            const t = tests[m.id];
            return (
              <div key={m.id} className="bg-ink-800 border border-ink-700 rounded-xl px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className={clsx('w-2 h-2 rounded-full', m.enabled ? 'bg-emerald-400' : 'bg-ink-500')} />
                  <span className="text-sm text-cream-200 font-mono">mcp__{m.name}__*</span>
                  <span className="text-[11px] text-ink-500 truncate">{m.transport === 'stdio' ? `${m.command} ${(m.args ?? []).join(' ')}` : m.url}</span>
                  <div className="ml-auto flex items-center gap-3 shrink-0">
                    <button onClick={() => runTest(m)} className="text-xs text-ink-400 hover:text-clay">{t?.busy ? 'Testing…' : 'Test'}</button>
                    <button onClick={() => toggle(m)} className="text-xs text-ink-400 hover:text-cream-200">{m.enabled ? 'Disable' : 'Enable'}</button>
                    <button onClick={() => remove(m)} className="text-xs text-ink-500 hover:text-red-400">Remove</button>
                  </div>
                </div>
                {t && !t.busy && (
                  t.ok
                    ? <div className="text-[11px] text-emerald-400 mt-1.5">✓ Connected — {t.tools?.length ?? 0} tools{t.tools?.length ? `: ${t.tools.slice(0, 8).join(', ')}${t.tools.length > 8 ? '…' : ''}` : ''}</div>
                    : <div className="text-[11px] text-red-400 mt-1.5">⚠ {t.error}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === null && (
        <div className="flex items-center gap-3">
          <Button onClick={() => setView('catalog')}>+ Add from catalog</Button>
          <button onClick={() => setView('custom')} className="text-xs text-ink-500 hover:text-cream-200">Add custom…</button>
        </div>
      )}

      {view === 'catalog' && (
        <div>
          <div className="grid grid-cols-2 gap-2">
            {MCP_CATALOG.map((e) => (
              <button key={e.id} onClick={() => setView(e)} className="flex items-start gap-2.5 text-left p-3 rounded-xl bg-ink-800 border border-ink-700 hover:border-clay transition-colors">
                <span className="text-lg leading-none mt-0.5">{e.icon}</span>
                <span className="min-w-0">
                  <span className="block text-sm text-cream-100">{e.name}</span>
                  <span className="block text-[11px] text-ink-500 leading-snug">{e.blurb}</span>
                </span>
              </button>
            ))}
          </div>
          <button onClick={() => setView(null)} className="text-xs text-ink-500 hover:text-cream-200 mt-2">Cancel</button>
        </div>
      )}

      {view === 'custom' && <CustomMcpForm onCancel={() => setView(null)} onAdd={addAndTest} />}
      {view && typeof view === 'object' && <CatalogMcpForm entry={view} onCancel={() => setView('catalog')} onAdd={addAndTest} />}

      <p className="text-xs text-ink-500">Secrets are encrypted at rest. Servers marked “needs Node” run a local command via <code className="text-clay">npx</code> — install Node.js (nodejs.org) first if you don't have it. Use <span className="text-cream-300">Test</span> to check a connection.</p>
    </Section>
  );
}

// Guided form for a catalog entry: prefilled command, labelled secret/arg fields.
function CatalogMcpForm({ entry, onCancel, onAdd }: { entry: McpCatalogEntry; onCancel: () => void; onAdd: (b: Parameters<typeof mcpApi.create>[1]) => Promise<void> }) {
  const { addToast } = useNotifications();
  const [name, setName] = useState(entry.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const input = 'w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-1.5 text-sm border border-ink-700 focus:outline-none focus:border-clay';

  const submit = async () => {
    const missing = (entry.fields ?? []).find((f) => !values[f.key]?.trim());
    if (missing) { addToast('Missing field', missing.label, 'error'); return; }
    setBusy(true);
    try {
      const argFields = (entry.fields ?? []).filter((f) => f.kind === 'arg');
      const envFields = (entry.fields ?? []).filter((f) => f.kind === 'env');
      const args = [...(entry.args ?? []), ...argFields.map((f) => values[f.key].trim())];
      const env = Object.fromEntries(envFields.map((f) => [f.key, values[f.key].trim()]));
      const body = entry.transport === 'stdio'
        ? { name: name.trim(), transport: 'stdio', command: entry.command, args, env: Object.keys(env).length ? env : undefined }
        : { name: name.trim(), transport: entry.transport, url: entry.url, headers: Object.keys(env).length ? env : undefined };
      await onAdd(body);
    } catch (e) {
      addToast('Failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5 border border-ink-700 rounded-xl p-3">
      <div className="flex items-center gap-2 text-sm text-cream-100"><span>{entry.icon}</span> Connect {entry.name}{entry.needsNode && <span className="text-[10px] text-ink-500 ml-1">· needs Node</span>}</div>
      <label className="text-xs text-ink-500 block">Tool prefix</label>
      <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
      {(entry.fields ?? []).map((f) => (
        <div key={f.key}>
          <label className="text-xs text-ink-500 block mb-0.5">{f.label}</label>
          <input className={input} type={f.kind === 'env' ? 'password' : 'text'} placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          {(f.help || f.link) && <p className="text-[11px] text-ink-600 mt-0.5">{f.help} {f.link && <a href={f.link} target="_blank" rel="noreferrer" className="text-clay hover:underline">Get it →</a>}</p>}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Button onClick={submit} disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add & test'}</Button>
        <button onClick={onCancel} className="text-xs text-ink-500 hover:text-cream-200">Back</button>
      </div>
    </div>
  );
}

// Advanced manual form (custom command / remote URL).
function CustomMcpForm({ onCancel, onAdd }: { onCancel: () => void; onAdd: (b: Parameters<typeof mcpApi.create>[1]) => Promise<void> }) {
  const [form, setForm] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '' });
  const [busy, setBusy] = useState(false);
  const input = 'w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-1.5 text-sm border border-ink-700 focus:outline-none focus:border-clay';
  const parseEnv = (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of s.split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    return out;
  };
  const submit = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      const env = parseEnv(form.env);
      const body = form.transport === 'stdio'
        ? { name: form.name.trim(), transport: 'stdio', command: form.command.trim(), args: form.args.split(' ').filter(Boolean), env: Object.keys(env).length ? env : undefined }
        : { name: form.name.trim(), transport: form.transport, url: form.url.trim(), headers: Object.keys(env).length ? env : undefined };
      await onAdd(body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border border-ink-700 rounded-xl p-3">
      <div className="grid grid-cols-2 gap-2">
        <input className={input} placeholder="name (e.g. github)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className={input} value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })}>
          <option value="stdio">stdio (local command)</option>
          <option value="http">http (remote)</option>
          <option value="sse">sse (remote)</option>
        </select>
      </div>
      {form.transport === 'stdio' ? (
        <div className="grid grid-cols-2 gap-2">
          <input className={input} placeholder="command (e.g. npx)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
          <input className={input} placeholder="args (e.g. -y @scope/server)" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
        </div>
      ) : (
        <input className={input} placeholder="https://mcp.example.com/sse" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
      )}
      <textarea className={input} rows={2} placeholder="env / headers — KEY=value per line" value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={busy || !form.name.trim()}>{busy ? 'Adding…' : 'Add & test'}</Button>
        <button onClick={onCancel} className="text-xs text-ink-500 hover:text-cream-200">Back</button>
      </div>
    </div>
  );
}

function EmailSection() {
  const { activeServer } = useServer();
  const { addToast } = useNotifications();
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [provider, setProvider] = useState('gmail');
  const [emailAddr, setEmailAddr] = useState('');
  const [password, setPassword] = useState('');
  const [custom, setCustom] = useState({ imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeServer) return;
    emailApi.status(activeServer.id).then(setStatus).catch(() => {});
  }, [activeServer]);

  if (!activeServer) return null;

  const connect = async () => {
    if (!emailAddr.trim() || !password.trim()) return;
    setBusy(true);
    try {
      const body = provider === 'custom'
        ? { email: emailAddr.trim(), password, provider, ...custom }
        : { email: emailAddr.trim(), password, provider };
      const r = await emailApi.connect(activeServer.id, body);
      setStatus({ connected: true, email: r.email });
      setPassword('');
      addToast('Mailbox connected', r.email, 'success');
    } catch (e) {
      addToast('Connection failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await emailApi.disconnect(activeServer.id);
      setStatus({ connected: false });
      addToast('Mailbox disconnected', undefined, 'info');
    } catch (e) {
      addToast('Failed', (e as Error).message, 'error');
    }
  };

  const input = 'w-full bg-ink-800 text-cream-100 rounded-lg px-3 py-1.5 text-sm border border-ink-700 focus:outline-none focus:border-clay';

  return (
    <Section title="Email" desc="Connect a mailbox so agents can read, search, sort, and send email (e.g. auto-file your inbox every morning).">
      {status?.connected ? (
        <Field label="Connected mailbox" desc={`${status.email} · IMAP ${status.imapHost ?? ''}`}>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <button onClick={disconnect} className="text-xs text-ink-500 hover:text-red-400">Disconnect</button>
          </div>
        </Field>
      ) : (
        <>
          <Field label="Provider" desc="Presets fill in the mail servers for you.">
            <select value={provider} onChange={(e) => setProvider(e.target.value)}
              className="bg-ink-800 text-cream-100 rounded-lg px-3 py-1.5 text-sm border border-ink-700 focus:outline-none focus:border-clay">
              <option value="gmail">Gmail</option>
              <option value="outlook">Outlook</option>
              <option value="yahoo">Yahoo</option>
              <option value="icloud">iCloud</option>
              <option value="zoho">Zoho — personal (@zoho.com)</option>
              <option value="zohopro">Zoho — own domain (US)</option>
              <option value="zoho_eu">Zoho — personal (EU / zoho.eu)</option>
              <option value="zohopro_eu">Zoho — own domain (EU)</option>
              <option value="custom">Custom (IMAP)</option>
            </select>
          </Field>
          {provider.startsWith('zoho') && (
            <p className="text-xs text-ink-500">
              In Zoho Mail: <span className="text-cream-300">Settings → Mail Accounts → IMAP Access</span> must be enabled. With 2FA on, generate an app password at{' '}
              <span className="text-cream-300">accounts.zoho.com → Security → App Passwords</span>. Pick the data centre your account lives in (the domain you sign in on: zoho.com vs zoho.eu); other regions (.in, .com.au, .jp, .ca) work via Custom with <code>imappro.zoho.&lt;tld&gt;</code>.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="you@example.com" value={emailAddr} onChange={(e) => setEmailAddr(e.target.value)} />
            <Input type="password" placeholder="App password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {provider === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <input className={input} placeholder="IMAP host" value={custom.imapHost} onChange={(e) => setCustom({ ...custom, imapHost: e.target.value })} />
              <input className={input} placeholder="IMAP port" type="number" value={custom.imapPort} onChange={(e) => setCustom({ ...custom, imapPort: Number(e.target.value) })} />
              <input className={input} placeholder="SMTP host" value={custom.smtpHost} onChange={(e) => setCustom({ ...custom, smtpHost: e.target.value })} />
              <input className={input} placeholder="SMTP port" type="number" value={custom.smtpPort} onChange={(e) => setCustom({ ...custom, smtpPort: Number(e.target.value) })} />
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={connect} disabled={busy || !emailAddr.trim() || !password.trim()}>{busy ? 'Verifying…' : 'Connect & verify'}</Button>
          </div>
          <p className="text-xs text-ink-500">
            Use an <span className="text-cream-300">app password</span>, not your login password. Gmail: turn on 2-Step Verification, then Google Account → Security → App passwords. Nothing is sent anywhere but your mail provider; the password is encrypted at rest.
          </p>
        </>
      )}
    </Section>
  );
}

function WebhookSection() {
  const { activeServer } = useServer();
  const { addToast } = useNotifications();
  const [info, setInfo] = useState<WebhookInfo | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus>({ running: false, url: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeServer) return;
    hooksApi.webhookUrl(activeServer.id).then(setInfo).catch(() => {});
    hooksApi.tunnelStatus(activeServer.id).then(setTunnel).catch(() => {});
  }, [activeServer]);

  if (!activeServer) return null;

  // The reachable base for the webhook: the public tunnel if running, else the local API.
  const base = tunnel.running && tunnel.url && info
    ? `${tunnel.url}/webhooks/${info.secret}`
    : info?.url ?? '';

  const copy = (text: string) => { navigator.clipboard.writeText(text).catch(() => {}); addToast('Copied', undefined, 'success'); };

  const toggleSig = async (v: boolean) => {
    try { setInfo(await hooksApi.patchWebhook(activeServer.id, { requireSignature: v })); }
    catch (e) { addToast('Failed', (e as Error).message, 'error'); }
  };

  const rotate = async () => {
    if (!confirm('Rotate the webhook secret? The old URL will stop working.')) return;
    try { setInfo(await hooksApi.patchWebhook(activeServer.id, { rotate: true })); addToast('Secret rotated', undefined, 'success'); }
    catch (e) { addToast('Failed', (e as Error).message, 'error'); }
  };

  const toggleTunnel = async () => {
    setBusy(true);
    try {
      setTunnel(tunnel.running ? await hooksApi.tunnelStop(activeServer.id) : await hooksApi.tunnelStart(activeServer.id));
    } catch (e) {
      addToast('Tunnel failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Webhooks & tunnel" desc="Let external services trigger workflows (via a Webhook trigger node) by POSTing to your URL.">
      <Field label="Public tunnel" desc={tunnel.running ? 'Your app is reachable from the internet.' : 'Expose the local app so webhooks can reach it from outside this machine.'}>
        <div className="flex items-center gap-2">
          {tunnel.running && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
          <Button variant={tunnel.running ? 'ghost' : 'primary'} onClick={toggleTunnel} disabled={busy}>
            {busy ? '…' : tunnel.running ? 'Stop tunnel' : 'Start tunnel'}
          </Button>
        </div>
      </Field>

      <div>
        <div className="text-sm text-cream-100 mb-1">Webhook URL {tunnel.running ? <span className="text-[11px] text-emerald-400">· public</span> : <span className="text-[11px] text-ink-500">· local only</span>}</div>
        <div className="flex items-center gap-1">
          <input readOnly value={base || 'loading…'} onFocus={(e) => e.currentTarget.select()}
            className="flex-1 bg-ink-800 text-cream-200 rounded-lg px-3 py-1.5 text-[11px] font-mono border border-ink-700 focus:outline-none focus:border-clay" />
          <button onClick={() => base && copy(base)} title="Copy" className="shrink-0 text-ink-400 hover:text-cream-200 px-2 py-1.5">⧉</button>
        </div>
        <p className="text-xs text-ink-500 mt-1">POST here to fire every enabled workflow with a Webhook trigger. Append <code className="text-clay">/your-event</code> to target a named event.</p>
      </div>

      <Toggle
        label="Require signed requests (HMAC)"
        desc="Reject calls without a valid X-CC-Signature header. Strongly recommended if the URL is public."
        checked={!!info?.requireSignature}
        onChange={toggleSig}
      />

      {info?.requireSignature && (
        <div className="bg-ink-800 border border-ink-700 rounded-xl p-3 text-xs text-cream-400 space-y-1.5">
          <div className="text-cream-200 font-medium">Signing</div>
          <p>Send header <code className="text-clay">X-CC-Signature: sha256=&lt;hex&gt;</code> where the hex is <code className="text-clay">HMAC-SHA256(secret, rawBody)</code>.</p>
          <div className="flex items-center gap-1">
            <span className="text-ink-500 shrink-0">secret:</span>
            <input readOnly value={info.secret} onFocus={(e) => e.currentTarget.select()}
              className="flex-1 bg-ink-850 text-cream-300 rounded px-2 py-1 font-mono border border-ink-700" />
            <button onClick={() => copy(info.secret)} title="Copy secret" className="text-ink-400 hover:text-cream-200 px-1.5">⧉</button>
          </div>
          <button onClick={rotate} className="text-[11px] text-ink-500 hover:text-red-400 mt-1">Rotate secret</button>
        </div>
      )}
    </Section>
  );
}

function Section({ title, desc, busy, children }: { title: string; desc?: string; busy?: boolean; children: React.ReactNode }) {
  return (
    <section className="bg-ink-850 border border-ink-800 rounded-2xl p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-cream-50">{title}</h2>
          {desc && <p className="text-sm text-ink-500 mt-0.5">{desc}</p>}
        </div>
        {busy && <span className="text-xs text-ink-500">Saving…</span>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-cream-100">{label}</div>
        {desc && <div className="text-xs text-ink-500 mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Field label={label} desc={desc}>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx('relative w-11 h-6 rounded-full transition-colors', checked ? 'bg-clay' : 'bg-ink-700')}
      >
        <span className={clsx('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform', checked && 'translate-x-5')} />
      </button>
    </Field>
  );
}

function NumberStepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onChange(Math.max(min, value - 1))} className="w-7 h-7 rounded-lg bg-ink-800 border border-ink-700 text-cream-300 hover:border-clay disabled:opacity-40" disabled={value <= min}>−</button>
      <span className="w-8 text-center text-sm text-cream-100 tabular-nums">{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} className="w-7 h-7 rounded-lg bg-ink-800 border border-ink-700 text-cream-300 hover:border-clay disabled:opacity-40" disabled={value >= max}>+</button>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={clsx('px-4 py-1.5 rounded-lg text-sm font-medium transition-colors', active ? 'bg-clay text-white' : 'text-cream-300 hover:bg-ink-750')}>
      {children}
    </button>
  );
}
