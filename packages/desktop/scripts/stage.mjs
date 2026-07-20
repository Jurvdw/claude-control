// Stage a self-contained backend for packaging. The monorepo hoists deps to the
// root node_modules, so we build an isolated server folder with its OWN
// production node_modules that electron-builder can bundle verbatim.
//
// Two packaging settings in package.json have no room for a comment there (JSON,
// and electron-builder rejects unknown keys — an attempt to document them inline
// failed schema validation), so they are recorded here:
//
//   compression: "normal"  electron-builder defaults NSIS to "maximum", a SOLID
//                          LZMA archive. Solid archives cannot be decompressed
//                          in parallel, so install pinned one core for 10m08s on
//                          a 323MB payload (measured). "normal" trades a
//                          slightly larger download for a far faster install.
//   nsis.oneClick: true    "false" renders the old Next-Next-Finish wizard.
//                          One-click is what current Electron apps ship: a
//                          progress bar, then the app opens itself.
//                          allowToChangeInstallationDirectory is incompatible
//                          with it and was removed alongside.
//   deleteAppDataOnUninstall: false — uninstalling must never take the user's
//                          workspace database with it.
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(fileURLToPath(import.meta.url), '../..'); // packages/desktop
const repoRoot = path.resolve(desktopDir, '../..');
// NOT 'build/': electron-builder reserves that name for build RESOURCES
// (icons, installer scripts) and excludes it from the app package, so a
// server staged there is silently dropped from app.asar.
const buildDir = path.join(desktopDir, 'staged');
const stagedServer = path.join(buildDir, 'server');
const stagedWebDist = path.join(buildDir, 'web', 'dist');

const R = (...p) => path.join(repoRoot, ...p);

/** Recursive byte size, for reporting what the prune actually saved. */
function dirSize(dir) {
  return countFiles(dir).bytes;
}

/** Recursive {files, bytes}. File count is what predicts Windows install time. */
function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countFiles(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(full).size;
    }
  }
  return { files, bytes };
}

console.log('› cleaning build dir');
// On Windows this intermittently fails with EBUSY: antivirus and the search
// indexer hold transient handles on a tree that was just written, and the
// staged payload is ~15k files, so the window is wide. The handles clear within
// a second or two — retry rather than failing the whole build.
for (let attempt = 1; ; attempt++) {
  try {
    rmSync(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    break;
  } catch (err) {
    if (attempt >= 5) {
      console.error(`\n✗ could not clean ${buildDir}: ${err.message}`);
      console.error('  something is holding a handle — close editors/terminals sitting in build/.');
      process.exit(1);
    }
    console.log(`  locked (${err.code}), retrying ${attempt}/4…`);
    execSync(process.platform === 'win32' ? 'timeout /t 2 /nobreak >nul' : 'sleep 2', { shell: true });
  }
}
mkdirSync(stagedServer, { recursive: true });

console.log('› copying server dist + prisma + package.json');
cpSync(R('packages/server/dist'), path.join(stagedServer, 'dist'), { recursive: true });
cpSync(R('packages/server/prisma'), path.join(stagedServer, 'prisma'), { recursive: true });
// Strip devDependencies and scripts rather than relying on --omit=dev.
//
// Install time on Windows is dominated by FILE COUNT, not bytes — ~17k of the
// staged files are under 16KB, and each one costs an NTFS create plus an
// antivirus scan. So a dev dependency that survives is expensive out of all
// proportion to its size.
//
// --omit=dev alone was not enough: `prisma` still landed in the tree, and npm
// HOISTS its transitive deps, so deleting the prisma folder afterwards orphaned
// effect (2,715 files) and fast-check (946) at the top level — 3,661 files of
// pure dead weight, none of it imported anywhere in src. Removing the
// declarations means npm never resolves that subtree at all, orphans included.
const pkg = JSON.parse(readFileSync(R('packages/server/package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(path.join(stagedServer, 'package.json'), JSON.stringify(pkg, null, 2));

console.log('› copying web build');
mkdirSync(path.dirname(stagedWebDist), { recursive: true });
cpSync(R('packages/web/dist'), stagedWebDist, { recursive: true });

console.log('› installing production dependencies (self-contained)…');
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
  cwd: stagedServer,
  stdio: 'inherit',
});

// `npm install --omit=dev` still drags in ~190MB that never runs: dev tooling
// pulled transitively, a download cache, and duplicate database engines. That
// weight is paid twice — once compressing the installer, once decompressing it
// on the user's machine — so it is the difference between a fast install and a
// multi-minute one.
//
// Everything here is verified unused at runtime, not guessed:
//   @prisma/engines  the ONLY engine the client loads is the copy inside
//                    .prisma/client (below). This package holds a duplicate of
//                    it plus schema-engine, which is CLI-only — and the app is
//                    CLI-free: db/embedded.ts applies the baseline SQL itself.
//   prisma           the CLI, same reason. A transitive dep, not ours.
//   typescript       the server runs compiled dist/; nothing compiles at runtime.
//   .cache           npm/prisma download cache that should never have shipped.
// The e2e suite drives the packaged app against a real database, so a wrong
// call here fails loudly rather than silently at a user's first query.
console.log('› pruning build-time-only packages');
let pruned = 0;
for (const rel of ['node_modules/@prisma/engines', 'node_modules/prisma', 'node_modules/typescript', 'node_modules/.cache']) {
  const target = path.join(stagedServer, rel);
  if (!existsSync(target)) continue;
  const before = dirSize(target);
  rmSync(target, { recursive: true, force: true });
  pruned += before;
}
console.log(`  ✓ removed ${(pruned / 1024 / 1024).toFixed(0)} MB`);

// File count is the number that predicts install time on Windows, so report it
// alongside size — a change that shrinks megabytes but not files will not make
// installing meaningfully faster, and this makes that visible at build time.
const counted = countFiles(stagedServer);
console.log(`  staged payload: ${counted.files} files, ${(counted.bytes / 1024 / 1024).toFixed(0)} MB`);

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
