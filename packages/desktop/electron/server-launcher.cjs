'use strict';

// Boots the backend when it lives inside app.asar.
//
// Electron transparently redirects `fs` and `require` from app.asar to
// app.asar.unpacked, but NOT child_process. So a dependency that locates its
// own binary via __dirname — embedded-postgres does exactly this for initdb /
// postgres, and the Claude Agent SDK for its executable — hands spawn() a path
// inside the archive and gets ENOENT, because there is no such file on disk.
//
// Rewriting the executable path at the child_process boundary fixes every such
// dependency at once, without patching any of them and without the server
// itself needing to know it is running inside an archive. Only the program
// being executed is rewritten; arguments are untouched, since those are
// frequently data paths (--pgdata, file arguments) that must stay as given.
//
// This exists solely so the backend can ship inside the asar: as ~15k loose
// files it cost ~10 minutes to install, at a measured ~32ms per file.

const childProcess = require('node:child_process');
const path = require('node:path');

const ASAR = `${path.sep}app.asar${path.sep}`;
const UNPACKED = `${path.sep}app.asar.unpacked${path.sep}`;

function toUnpacked(file) {
  return typeof file === 'string' && file.includes(ASAR) ? file.split(ASAR).join(UNPACKED) : file;
}

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = function patched(file, ...rest) {
    return original.call(this, toUnpacked(file), ...rest);
  };
}

// Electron redirects asar READS to app.asar.unpacked, but not every fs call —
// chmod in particular throws ENOENT on an archive path. embedded-postgres
// chmod()s its binaries during setup, so without this the database never
// starts. Redirect only when the unpacked file genuinely exists, leaving
// ordinary paths (and genuine ENOENTs) untouched.
const fs = require('node:fs');
function redirectIfUnpacked(target) {
  if (typeof target !== 'string' || !target.includes(ASAR)) return target;
  const unpacked = target.split(ASAR).join(UNPACKED);
  return fs.existsSync(unpacked) ? unpacked : target;
}

for (const name of ['chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function patched(target, ...rest) {
    return original.call(this, redirectIfUnpacked(target), ...rest);
  };
}
for (const name of ['chmod', 'chown', 'utimes']) {
  const original = fs.promises[name];
  if (typeof original !== 'function') continue;
  fs.promises[name] = function patched(target, ...rest) {
    return original.call(this, redirectIfUnpacked(target), ...rest);
  };
}

const entry = process.env.CC_SERVER_ENTRY;
if (!entry) {
  console.error('[launcher] CC_SERVER_ENTRY is not set');
  process.exit(1);
}

// The server is ESM, so it has to be import()ed rather than require()d, and on
// Windows import() only accepts a file:// URL — a bare drive path is read as a
// protocol. This file stays CommonJS so the patches above are applied before
// the server (and its dependencies) are ever evaluated.
const { pathToFileURL } = require('node:url');
import(pathToFileURL(entry).href).catch((err) => {
  console.error('[launcher] failed to start server:', err);
  process.exit(1);
});
