import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { apiKeys as keysApi } from '../lib/api';
import type { ProviderStatus } from '../lib/types';
import { Button, Input } from '../components/ui';

type Tab = 'apikey' | 'subscription';

export default function OnboardingPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [tab, setTab] = useState<Tab>('apikey');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    keysApi.providerStatus().then((s) => {
      setStatus(s);
      if (s.subscriptionAvailable) setTab('subscription'); // prefer subscription in the desktop app
    }).catch(() => {});
  }, []);

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
      nav('/');
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
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
                  <div className="text-center text-[11px] text-ink-500 mt-3">— or paste a setup-token below —</div>
                </div>
              )}
              <div className="text-sm text-cream-200 space-y-2">
                <p>Run agents on your <strong className="text-clay">Claude Pro / Max / Team / Enterprise</strong> plan — usage draws from your plan limits instead of pay-per-token.</p>
                <ol className="list-decimal list-inside text-cream-400 text-xs space-y-1 bg-ink-800 rounded-lg p-3">
                  <li>Install Claude Code: <code className="text-clay">npm i -g @anthropic-ai/claude-code</code></li>
                  <li>Run <code className="text-clay">claude setup-token</code> and sign in with your Claude account.</li>
                  <li>Copy the token it prints and paste it below.</li>
                </ol>
              </div>
              <div>
                <label className="text-xs text-cream-400 mb-1 block">Subscription token</label>
                <Input type="password" placeholder="sk-ant-oat…" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
              </div>
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
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Validating…' : 'Connect & validate'}</Button>
            <Button type="button" variant="ghost" onClick={() => nav('/')}>Skip for now</Button>
          </div>
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
