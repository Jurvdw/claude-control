import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  resolveClaudeBinary,
  parseSetupTokenOutput,
  startSetupToken,
  getSetupTokenStatus,
  cancelSetupToken,
} from '../src/llm/setupTokenFlow.js';

vi.mock('../src/llm/index.js', () => ({
  persistSubscriptionToken: vi.fn(async (_userId: string, token: string) =>
    token.includes('bad')
      ? { apiKey: null, valid: false, error: 'rejected' }
      : { apiKey: { id: '1', label: 'subscription', last4: 'good', valid: true, createdAt: new Date() }, valid: true, error: undefined },
  ),
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  kill = vi.fn();
}

describe('resolveClaudeBinary', () => {
  it('resolves the win32-x64 bundled binary path', () => {
    if (process.platform !== 'win32' || process.arch !== 'x64') return; // this app is Windows-only today
    const p = resolveClaudeBinary();
    expect(p.toLowerCase()).toMatch(/claude-agent-sdk-win32-x64.*claude\.exe$/i);
  });
});

describe('parseSetupTokenOutput', () => {
  it('extracts a token from surrounding CLI text', () => {
    const stdout = 'Signed in!\n\nYour token: sk-ant-oat01-abcDEF_123-xyz\n\nUse this to authenticate.';
    expect(parseSetupTokenOutput(stdout)).toBe('sk-ant-oat01-abcDEF_123-xyz');
  });

  it('returns null when no token is present', () => {
    expect(parseSetupTokenOutput('Sign-in cancelled.')).toBeNull();
  });
});

describe('setup-token session orchestration', () => {
  beforeEach(() => {
    cancelSetupToken('user-1'); // clear any session left by a previous test
  });

  it('reports waiting while the child is running', () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'waiting' });
  });

  it('reports success once the token is captured and persisted', async () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    fake.stdout.emit('data', Buffer.from('token: sk-ant-oat01-good\n'));
    fake.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 0)); // let persistSubscriptionToken's promise settle
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'success' });
  });

  it('reports an error when the process exits without a token', async () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    fake.emit('exit', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(getSetupTokenStatus('user-1')?.status).toBe('error');
  });

  it('reports an error when the saved token is rejected', async () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    fake.stdout.emit('data', Buffer.from('sk-ant-oat-bad\n'));
    fake.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'error', error: 'rejected' });
  });

  it('cancel kills the child and clears the session', () => {
    const fake = new FakeChild();
    startSetupToken('user-1', () => fake as never);
    cancelSetupToken('user-1');
    expect(fake.kill).toHaveBeenCalled();
    expect(getSetupTokenStatus('user-1')).toBeNull();
  });

  it('starting a new flow cancels any in-flight one for the same user', () => {
    const first = new FakeChild();
    startSetupToken('user-1', () => first as never);
    const second = new FakeChild();
    startSetupToken('user-1', () => second as never);
    expect(first.kill).toHaveBeenCalled();
    expect(getSetupTokenStatus('user-1')).toEqual({ status: 'waiting' });
  });
});
