# Releasing an update

Claude Control auto-updates from GitHub Releases. The app checks 15s after
launch and every 6h, downloads in the background, and installs **on quit** — a
running agent is never interrupted mid-task.

## One-time setup

1. Create the repo `Jurvdw/claude-control` on GitHub and push. (If you use a
   different name/owner, update `build.publish` in `packages/desktop/package.json`
   — it is baked into the app as `resources/app-update.yml` at build time.)
2. Create a token with `repo` scope and export it as `GH_TOKEN` when releasing.
   - **Public repo**: the token is only needed to *upload*. Users download
     anonymously, nothing is embedded in the app.
   - **Private repo**: users also need a token to *download*, which would mean
     shipping a credential inside the app. Prefer a public repo for releases even
     if the source stays private.

## Cutting a release

```bash
# 1. Bump the version — this is what the updater compares against.
npm version patch --workspace @cc/desktop --no-git-tag-version

# 2. Build + upload installer, blockmap and latest.yml to a GitHub Release.
GH_TOKEN=ghp_xxx npm run release
```

`electron-builder` creates the release as a **draft**. Publish it in the GitHub
UI when ready — clients only see it once it's published.

Version numbers must increase (semver). The updater ignores anything that isn't
newer than the running version, so a re-published identical version is a no-op.

## What each artifact does

| File | Purpose |
|---|---|
| `Claude Control Setup <v>.exe` | NSIS installer — what users download and what the updater installs |
| `latest.yml` | The feed manifest: version, filename, sha512. **The updater reads this first** |
| `*.blockmap` | Enables differential download (only changed chunks) |
| `Claude Control <v>.exe` | Portable build. **Does not auto-update** — no install location to replace |

All four must be attached to the release. `npm run release` handles that.

## Verifying it works

Install version A, publish version B, reopen the app: within ~15s a toast says
an update is downloading, then that it's ready. Settings → About shows the
current version and a "Restart & install" button. Closing the app applies it.

## Notes

- Builds are **unsigned** (`signAndEditExecutable: false`). Updates apply fine,
  but Windows SmartScreen warns on first install. Code signing needs a paid
  certificate; worth it before shipping to anyone who isn't you.
- Schema changes need no migration step: `ADDITIVE_SQL` in `db/embedded.ts` runs
  idempotently on every boot, so a new version creates its own tables. Keep it
  additive — a destructive change would break rollback to an older version.
- Update failures are non-fatal by design: no network, no release, or a bad feed
  logs a warning and the app carries on.

## Running the Electron e2e suite

```bash
npm run pack -w @cc/desktop   # refresh release/win-unpacked FIRST
npm run e2e
```

The suite drives the packaged app in `release/win-unpacked`, **not** the
installed one, because the Electron shell (main.cjs, preload.cjs, updater.cjs)
lives inside `app.asar` and only changes when a build is produced — copying
`server/dist` and `web/dist` into an installed app never updates it. Skipping
`pack` means testing a stale binary; that is exactly how the first run reported
a real-looking failure that was only an out-of-date bundle.

Requirements:
- The installed app must be **closed** — `PORT` is hard-coded to 4000 in
  main.cjs (after the env spread, so it cannot be overridden).
- Each test launches with a throwaway `--user-data-dir`, giving it its own
  Postgres, storage and encryption key. Your real workspace is never touched.
- No agent runs: the tests assert plumbing, so they are deterministic and cost
  no subscription quota.
