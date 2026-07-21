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
