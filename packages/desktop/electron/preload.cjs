'use strict';

// The only bridge between the Electron shell and the web app. contextIsolation
// stays on and nodeIntegration off — the renderer gets these three functions and
// nothing else, no ipcRenderer handle it could use to reach other channels.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccDesktop', {
  version: () => ipcRenderer.invoke('cc:version'),

  /** Subscribe to update lifecycle events. Returns an unsubscribe function. */
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('cc:update', handler);
    return () => ipcRenderer.removeListener('cc:update', handler);
  },

  /** Quit and install a downloaded update now (the user explicitly opted in). */
  installNow: () => ipcRenderer.invoke('cc:install-update'),

  /** Open a native folder picker. Resolves to the chosen path, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke('cc:pick-folder'),
});
