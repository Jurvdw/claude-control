'use strict';

// Auto-update. Downloads in the background and installs when the app quits —
// never mid-session, because a running agent holds state the user cares about
// (in-flight runs, parked ResumeJobs, and the embedded Postgres, which needs a
// clean SIGTERM shutdown). Swapping binaries under a live run would strand all
// three, so the only safe install point is a quit we're already performing.

const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_CHECK_DELAY_MS = 15_000; // let the backend finish booting first

// Renderer may not exist yet (or may be reloading) — send defensively.
function notify(getWindow, channel, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send(channel, payload);
  }
}

function initAutoUpdate(getWindow, log = console) {
  // In dev there's no update feed and no installed app to replace; electron-
  // updater throws rather than no-ops, so don't even wire it up.
  if (!require('electron').app.isPackaged) {
    log.info?.('[updater] skipped (not packaged)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Pre-releases are opt-in only; a normal user should never be moved onto one.
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = log;

  autoUpdater.on('update-available', (info) => {
    log.info?.(`[updater] update available: ${info?.version}`);
    notify(getWindow, 'cc:update', { state: 'available', version: info?.version });
  });

  autoUpdater.on('update-not-available', () => {
    notify(getWindow, 'cc:update', { state: 'current' });
  });

  autoUpdater.on('download-progress', (p) => {
    notify(getWindow, 'cc:update', { state: 'downloading', percent: Math.round(p?.percent ?? 0) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info?.(`[updater] downloaded ${info?.version}; installs on quit`);
    notify(getWindow, 'cc:update', { state: 'ready', version: info?.version });
  });

  autoUpdater.on('error', (err) => {
    // A missing feed, no network, or an unpublished repo must never break the
    // app — updating is best-effort.
    log.warn?.(`[updater] ${err?.message ?? err}`);
    notify(getWindow, 'cc:update', { state: 'error', message: String(err?.message ?? err) });
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdate };
