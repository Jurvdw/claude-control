import vm from 'node:vm';
import { registerTool } from './registry.js';

// EXPERIMENTAL: sandboxed JS via node:vm. Hard timeout, no fs/network, no
// require/import. Requires Commander approval by default.
registerTool({
  name: 'run_code',
  description:
    'Run a short snippet of sandboxed JavaScript (no filesystem, no network). Return a value or console.log output. Experimental — requires approval.',
  input_schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript to evaluate. The last expression is returned.' },
    },
    required: ['code'],
  },
  requiresApproval: true,
  summarize: (input) => `Run code: ${String(input.code).slice(0, 60)}…`,
  async execute(input) {
    const logs: string[] = [];
    const sandbox = {
      console: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
      Math,
      JSON,
      Date,
    };
    const context = vm.createContext(sandbox, { name: 'run_code' });
    try {
      const script = new vm.Script(String(input.code));
      const result = script.runInContext(context, { timeout: 2000 });
      const out = logs.length ? logs.join('\n') : '';
      const ret = result !== undefined ? `\n=> ${stringify(result)}` : '';
      return `${out}${ret}`.trim() || '(no output)';
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
});

function stringify(v: unknown): string {
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}
