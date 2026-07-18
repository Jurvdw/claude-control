import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import { Button, Input } from '../components/ui';

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="text-center mb-8">
          <div className="text-clay text-3xl font-bold tracking-tight">Claude Control</div>
          <p className="text-cream-400 mt-2 text-sm">Your AI control center. Welcome back, Commander.</p>
        </div>
        <form onSubmit={submit} className="bg-ink-850 border border-ink-700 rounded-2xl p-6 flex flex-col gap-4">
          <div>
            <label className="text-xs text-cream-400 mb-1 block">Email</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="text-xs text-cream-400 mb-1 block">Password</label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        </form>
        <p className="text-center text-sm text-cream-400 mt-4">
          No account? <Link to="/register" className="text-clay hover:text-clay-400">Create one</Link>
        </p>
      </div>
    </div>
  );
}
