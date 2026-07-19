// Claude Control — Electron main process.
// Boots the existing Node backend (embedded Postgres + Express + Socket.IO) as
// a child process running under Electron's own Node (self-contained, no system
// Node needed), then renders the UI in a native window.

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { initAutoUpdate } = require('./updater.cjs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Clean per-user data folder (…/AppData/Roaming/Claude Control).
app.setName('Claude Control');
// Single instance — a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();

const PORT = 4000;
const APP_URL = `http://localhost:${PORT}`;

let backend = null;
let mainWindow = null;

// Resolve where the backend + web build live, in dev and when packaged.
function paths() {
  if (app.isPackaged) {
    // extraResources places these under resources/.
    const res = process.resourcesPath;
    return {
      serverDir: path.join(res, 'server'),
      serverEntry: path.join(res, 'server', 'dist', 'index.js'),
    };
  }
  const serverDir = path.join(__dirname, '..', '..', 'server');
  return { serverDir, serverEntry: path.join(serverDir, 'dist', 'index.js') };
}

// Generate + persist a unique encryption key & session secret per install, so
// stored credentials are encrypted with a key that's stable for this machine
// and not shared across installs.
function getSecrets() {
  const userData = app.getPath('userData');
  const file = path.join(userData, 'secrets.json');
  try {
    if (fs.existsSync(file)) {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.ENCRYPTION_KEY && s.SESSION_SECRET) return s;
    }
  } catch {
    /* regenerate below */
  }
  const secrets = {
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    SESSION_SECRET: crypto.randomBytes(24).toString('base64url'),
  };
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  } catch (err) {
    console.error('Failed to persist secrets:', err);
  }
  return secrets;
}

function startBackend() {
  const { serverDir, serverEntry } = paths();
  const userData = app.getPath('userData');
  const secrets = getSecrets();

  backend = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // run the child as plain Node, not an Electron UI
      PORT: String(PORT),
      // Keep data + uploads in the per-user app data folder (writable, persistent).
      EMBEDDED_PG: 'true',
      PG_DATA_DIR: path.join(userData, 'pg'),
      STORAGE_LOCAL_DIR: path.join(userData, 'storage'),
      // The backend's stdout is piped to this process, which as a packaged
      // Windows GUI app has no console — so without a file the logs are simply
      // lost. Give it somewhere durable to write.
      LOG_DIR: path.join(userData, 'logs'),
      // This is a self-hosted, single-user desktop app → unlock Claude subscription mode.
      SELF_HOSTED: 'true',
      // Per-install secrets (stable for this machine, unique per install).
      ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
      SESSION_SECRET: secrets.SESSION_SECRET,
      // Never pop the system browser — this is a desktop app.
      OPEN_BROWSER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backend.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backend.on('exit', (code) => {
    if (code && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox('Claude Control', `The backend stopped unexpectedly (code ${code}).`);
    }
  });
}

// Poll the backend until it answers, then run cb.
function waitForBackend(cb, attempt = 0) {
  const req = http.get(`${APP_URL}/auth/me`, (res) => {
    res.resume();
    cb();
  });
  req.on('error', () => {
    if (attempt > 120) {
      dialog.showErrorBox('Claude Control', 'The app failed to start in time. See the console for details.');
      return;
    }
    setTimeout(() => waitForBackend(cb, attempt + 1), 1000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#1a1915',
    title: 'Claude Control',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Open external links (e.g. Anthropic console) in the system browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  waitForBackend(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(APP_URL);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  startBackend();
  createWindow();

  ipcMain.handle('cc:version', () => app.getVersion());
  ipcMain.handle('cc:install-update', () => {
    // before-quit still runs, so the backend gets its clean SIGTERM and the
    // embedded Postgres shuts down properly before the installer swaps files.
    app.isQuitting = true;
    require('electron-updater').autoUpdater.quitAndInstall();
  });
  initAutoUpdate(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Stop the backend (and its embedded Postgres) cleanly on quit.
app.on('before-quit', () => {
  app.isQuitting = true;
  if (backend && !backend.killed) {
    // SIGTERM triggers the server's graceful shutdown (stops embedded Postgres).
    backend.kill('SIGTERM');
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
