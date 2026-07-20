import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { apiKeys as keysApi, servers as serversApi } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import type { ProviderStatus } from '../lib/types';
import { Button, Input } from '../components/ui';

type Tab = 'apikey' | 'subscription';
type SetupState = 'idle' | 'starting' | 'waiting' | 'error';

export default function OnboardingPage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [tab, setTab] = useState<Tab>('apikey');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setupState, setSetupState] = useState<SetupState>('idle');
  const [setupError, setSetupError] = useState('');
  const [showManualPaste, setShowManualPaste] = useState(false);

  useEffect(() => {
    keysApi.providerStatus().then((s) => {
      setStatus(s);
      if (s.subscriptionAvailable) setTab('subscription'); // prefer subscription in the desktop app
    }).catch(() => {});
  }, []);

  // A workspace is auto-created the moment Claude is connected, by whichever
  // path got there — no separate "create your first workspace" step.
  const finishOnboarding = async () => {
    const { server } = await serversApi.create(`${user?.displayName ?? 'My'}'s Workspace`);
    nav(`/${server.id}`);
  };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { valid, error: verr } = await keysApi.create(undefined, value.trim(), tab === 'subscription' ? 'subscription' : 'api');
      if (!valid) {
        setError(verr || 'That credential failed validation. Double-check it and try again.');
        return;
      }
      await finishOnboarding();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connectExisting = async () => {
    setBusy(true);
    setError('');
    try {
      const { valid, error: verr } = await keysApi.connectExistingLogin();
      if (!valid) {
        setError(verr || "Couldn't use your Claude login. Try `claude login`, or paste a setup-token instead.");
        return;
      }
      await finishOnboarding();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startSetup = async () => {
    setSetupState('starting');
    setSetupError('');
    try {
      await keysApi.startSetupToken();
      setSetupState('waiting');
    } catch (err) {
      setSetupState('error');
      setSetupError((err as Error).message);
    }
  };

  const cancelSetup = async () => {
    await keysApi.cancelSetupToken().catch(() => {});
    setSetupState('idle');
  };

  // Poll while waiting for the user to finish signing in in their browser.
  useEffect(() => {
    if (setupState !== 'waiting') return;
    const interval = setInterval(async () => {
      try {
        const s = await keysApi.setupTokenStatus();
        if (s.status === 'success') {
          clearInterval(interval);
          await finishOnboarding();
        } else if (s.status === 'error') {
          clearInterval(interval);
          setSetupState('error');
          setSetupError(s.error || 'Sign-in failed. Try again, or paste a token manually.');
        }
        // 'waiting' / 'idle' → keep polling
      } catch {
        // transient network hiccup — keep polling rather than failing on one bad request
      }
    }, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupState]);

  const subAvailable = status?.subscriptionAvailable;
  const loginDetected = status?.claudeLoginDetected;

  return (
    <div className="h-full flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-lg animate-fade-in py-8">
        <div className="text-center mb-6">
          <div className="text-clay text-2xl font-bold">Connect Claude</div>
          <p className="text-cream-400 mt-2 text-sm">Choose how your agents talk to Claude.</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4 bg-ink-800 p-1 rounded-xl">
          {subAvailable && (
            <TabButton active={tab === 'subscription'} onClick={() => { setTab('subscription'); setValue(''); setError(''); }}>
              Claude subscription
            </TabButton>
          )}
          <TabButton active={tab === 'apikey'} onClick={() => { setTab('apikey'); setValue(''); setError(''); }}>
            API key
          </TabButton>
        </div>

        <form onSubmit={connect} className="bg-ink-850 border border-ink-700 rounded-2xl p-6 flex flex-col gap-4">
          {tab === 'subscription' ? (
            <>
              {loginDetected && (
                <div className="bg-ink-800 border border-emerald-500/40 rounded-xl p-4 animate-fade-in">
                  <div className="flex items-center gap-2 text-emerald-300 text-sm font-medium">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" /> You're signed in with Claude on this machine
                  </div>
                  <p className="text-xs text-cream-400 mt-1">Use your existing login — nothing to paste.</p>
                  <Button type="button" className="mt-3 w-full" onClick={connectExisting} disabled={busy}>
                    {busy ? 'Connecting…' : 'Use my Claude login'}
                  </Button>
                  <div className="text-center text-[11px] text-ink-500 mt-3">— or connect a different account below —</div>
                </div>
              )}

              <div className="text-sm text-cream-200 space-y-3">
                <p>Run agents on your <strong className="text-clay">Claude Pro / Max / Team / Enterprise</strong> plan — usage draws from your plan limits instead of pay-per-token.</p>

                {setupState === 'idle' && (
                  <Button type="button" className="w-full" onClick={startSetup}>Connect with Claude subscription</Button>
                )}
                {setupState === 'starting' && (
                  <Button type="button" className="w-full" disabled>Starting…</Button>
                )}
                {setupState === 'waiting' && (
                  <div className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col items-center gap-2 text-center">
                    <div className="animate-pulse-dot text-clay text-sm font-medium">Waiting for you to sign in…</div>
                    <p className="text-xs text-cream-400">A browser tab just opened to Anthropic's sign-in page. Come back here once you've signed in.</p>
                    <Button type="button" variant="ghost" onClick={cancelSetup}>Cancel</Button>
                  </div>
                )}
                {setupState === 'error' && (
                  <div className="bg-red-950/40 border border-red-500/30 rounded-xl p-3 text-sm text-red-300">
                    {setupError}
                    <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => setSetupState('idle')}>Try again</Button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setShowManualPaste((v) => !v)}
                  className="text-xs text-ink-500 hover:text-cream-300 underline decoration-dotted"
                >
                  {showManualPaste ? 'Hide manual option' : 'Already have a token, or connecting from another machine?'}
                </button>
              </div>

              {showManualPaste && (
                <div className="border-t border-ink-700 pt-4 space-y-3">
                  <ol className="list-decimal list-inside text-cream-400 text-xs space-y-1 bg-ink-800 rounded-lg p-3">
                    <li>On any machine with Node.js: <code className="text-clay">npm i -g @anthropic-ai/claude-code</code></li>
                    <li>Run <code className="text-clay">claude setup-token</code> and sign in with your Claude account.</li>
                    <li>Copy the token it prints and paste it below.</li>
                  </ol>
                  <div>
                    <label className="text-xs text-cream-400 mb-1 block">Subscription token</label>
                    <Input type="password" placeholder="sk-ant-oat…" value={value} onChange={(e) => setValue(e.target.value)} />
                  </div>
                  <Button type="submit" disabled={busy || !value.trim()}>{busy ? 'Validating…' : 'Connect & validate'}</Button>
                </div>
              )}

              <p className="text-[11px] text-ink-500 leading-relaxed border-t border-ink-700 pt-3">
                ⚠️ For individual use of <em>your own</em> subscription on your own machine only. Never pool, proxy, or resell subscription access. Anthropic's policy on this has changed before and this mode may stop working.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-cream-200">Bring your own <strong>Anthropic API key</strong>. It's encrypted at rest (AES-256-GCM) and billed pay-per-token to your account.</p>
              <div>
                <label className="text-xs text-cream-400 mb-1 block">Anthropic API key</label>
                <Input type="password" placeholder="sk-ant-…" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
                <p className="text-xs text-ink-500 mt-1">Get one at console.anthropic.com. We run a tiny validation call before saving.</p>
              </div>
            </>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}
          {tab === 'apikey' && (
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? 'Validating…' : 'Connect & validate'}</Button>
              <Button type="button" variant="ghost" onClick={() => nav('/')}>Skip for now</Button>
            </div>
          )}
          {tab === 'subscription' && !showManualPaste && (
            <Button type="button" variant="ghost" onClick={() => nav('/')}>Skip for now</Button>
          )}
        </form>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx('flex-1 py-2 rounded-lg text-sm font-medium transition-colors', active ? 'bg-clay text-white' : 'text-cream-300 hover:bg-ink-750')}
    >
      {children}
    </button>
  );
}
