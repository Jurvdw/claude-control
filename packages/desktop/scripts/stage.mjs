// Stage a self-contained backend for packaging. The monorepo hoists deps to the
// root node_modules, so we build an isolated server folder with its OWN
// production node_modules that electron-builder can bundle verbatim.
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(fileURLToPath(import.meta.url), '../..'); // packages/desktop
const repoRoot = path.resolve(desktopDir, '../..');
const buildDir = path.join(desktopDir, 'build');
const stagedServer = path.join(buildDir, 'server');
const stagedWebDist = path.join(buildDir, 'web', 'dist');

const R = (...p) => path.join(repoRoot, ...p);

console.log('› cleaning build dir');
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(stagedServer, { recursive: true });

console.log('› copying server dist + prisma + package.json');
cpSync(R('packages/server/dist'), path.join(stagedServer, 'dist'), { recursive: true });
cpSync(R('packages/server/prisma'), path.join(stagedServer, 'prisma'), { recursive: true });
cpSync(R('packages/server/package.json'), path.join(stagedServer, 'package.json'));

console.log('› copying web build');
mkdirSync(path.dirname(stagedWebDist), { recursive: true });
cpSync(R('packages/web/dist'), stagedWebDist, { recursive: true });

console.log('› installing production dependencies (self-contained)…');
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
  cwd: stagedServer,
  stdio: 'inherit',
});

// The Prisma client is generated code + a native engine; copy the already-
// generated output from the repo (prisma CLI is a devDep, not installed here).
//
// This must NOT be best-effort. A missing or stale client produces an app that
// boots fine and then 500s on the first route touching a newer model — the
// vault and email drafts shipped dead this way, because the copy was skipped
// silently and nothing checked afterwards. Fail the build instead.
console.log('› copying generated Prisma client');
for (const rel of ['node_modules/.prisma', 'node_modules/@prisma/client']) {
  if (!existsSync(R(rel))) {
    console.error(`\n✗ ${rel} is missing — run \`npx prisma generate\` before packaging.`);
    process.exit(1);
  }
  cpSync(R(rel), path.join(stagedServer, rel), { recursive: true });
}

// Verify the staged client actually knows about the current schema. Comparing
// against the schema's own models catches a stale client that was generated
// before the newest migration — the failure mode a bare existence check misses.
const schema = readFileSync(R('packages/server/prisma/schema.prisma'), 'utf8');
const models = [...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);
const dts = readFileSync(path.join(stagedServer, 'node_modules/.prisma/client/index.d.ts'), 'utf8');
const missing = models.filter((m) => !dts.includes(m));
if (missing.length) {
  console.error(`\n✗ staged Prisma client is stale — missing: ${missing.join(', ')}`);
  console.error('  run `npx prisma generate` and re-run the build.');
  process.exit(1);
}
console.log(`  ✓ client covers all ${models.length} schema models`);

console.log('✓ staged at', stagedServer);
