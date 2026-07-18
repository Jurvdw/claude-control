// Stage a self-contained backend for packaging. The monorepo hoists deps to the
// root node_modules, so we build an isolated server folder with its OWN
// production node_modules that electron-builder can bundle verbatim.
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
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
console.log('› copying generated Prisma client');
if (existsSync(R('node_modules/.prisma'))) {
  cpSync(R('node_modules/.prisma'), path.join(stagedServer, 'node_modules/.prisma'), { recursive: true });
}
if (existsSync(R('node_modules/@prisma/client'))) {
  cpSync(R('node_modules/@prisma/client'), path.join(stagedServer, 'node_modules/@prisma/client'), { recursive: true });
}

console.log('✓ staged at', stagedServer);
