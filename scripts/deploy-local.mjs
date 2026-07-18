// Deploy the current build into the installed desktop app.
//
// The Prisma CLIENT is the easy thing to forget: it is generated code living in
// node_modules, not in dist, so copying dist alone leaves the app with a client
// that has no idea the newest models exist. That failure is invisible until a
// route touches one and throws a 500 — the privacy vault AND email drafts were
// both dead in the installed app for exactly this reason, while every test
// against the repo passed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const APP = process.env.CC_APP_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Claude Control');
const REPO = path.resolve(import.meta.dirname, '..');

function copy(from, to) {
  try {
    execFileSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' });
  } catch {
    // robocopy exits 1-7 on success; only a thrown ENOENT would matter here.
  }
}

if (!existsSync(APP)) {
  console.error(`app not found at ${APP} (set CC_APP_DIR)`);
  process.exit(1);
}

const targets = [
  ['packages/server/dist', 'resources/server/dist'],
  ['packages/web/dist', 'resources/web/dist'],
  // Regenerated whenever schema.prisma changes — must ship alongside dist.
  ['node_modules/.prisma/client', 'resources/server/node_modules/.prisma/client'],
];

for (const [rel, dest] of targets) {
  const from = path.join(REPO, rel);
  if (!existsSync(from)) {
    console.error(`missing source: ${rel} — run npm run build first`);
    process.exit(1);
  }
  copy(from, path.join(APP, dest));
  console.log(`  ${rel} -> <app>/${dest}`);
}

// Verify rather than assume: a silently failed deploy cost hours this session.
const clientDts = path.join(APP, 'resources/server/node_modules/.prisma/client/index.d.ts');
const dts = existsSync(clientDts) ? readFileSync(clientDts, 'utf8') : '';
const missing = ['VaultEntry', 'EmailDraft', 'Plan', 'McpServer'].filter((m) => !dts.includes(m));
console.log(missing.length ? `\nWARNING: prisma client is missing ${missing.join(', ')}` : '\nprisma client OK');

console.log('\nDeployed. Restart the app for server changes to take effect.');
console.log('NOTE: the Electron shell (main.cjs / preload.cjs / updater.cjs) lives inside');
console.log('app.asar and is NOT updated by this script — that requires a full install.');
