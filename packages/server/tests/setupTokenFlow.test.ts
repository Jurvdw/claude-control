import { describe, it, expect } from 'vitest';
import { resolveClaudeBinary, parseSetupTokenOutput } from '../src/llm/setupTokenFlow.js';

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
