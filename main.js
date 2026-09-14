'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { checkDeps } = require('./lib/deps');
const { toIpcError } = require('./lib/errors');
const appSettings = require('./lib/appSettings');
const youtubeProvider = require('./lib/youtubeProvider');
const { downloadManager } = require('./lib/downloadManager');

/** @type {BrowserWindow|null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 720,
    minHeight: 680,
    title: 'YouTube Downloader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * @param {string} channel
 * @param {unknown} payload
 */
function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerIpc() {
  ipcMain.handle('deps:check', async () => {
    try {
      const deps = await checkDeps();
      return { ok: true, ...deps };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('settings:get', async () => {
    return { ok: true, ...appSettings.getSettings() };
  });

  ipcMain.handle('settings:set', async (_event, patch) => {
    try {
      const settings = appSettings.setSettings(patch || {});
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'concurrency')) {
        downloadManager.refresh();
      }
      return { ok: true, ...settings };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('settings:pickCookiesFile', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: 'Choose cookies.txt',
        properties: ['openFile'],
        filters: [
          { name: 'Cookies', extensions: ['txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { ok: true, canceled: true, ...appSettings.getSettings() };
      }
      const settings = appSettings.setCookiesPath(result.filePaths[0]);
      return { ok: true, canceled: false, ...settings };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('url:analyze', async (_event, { url }) => {
    try {
      const data = await youtubeProvider.analyze(url);
      return { ok: true, ...data };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('url:loadMore', async (_event, { url, start }) => {
    try {
      const data = await youtubeProvider.loadMore(url, start);
      return { ok: true, ...data };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('queue:enqueue', async (_event, { jobs }) => {
    try {
      const jobIds = downloadManager.enqueue(jobs || []);
      return { ok: true, jobIds, queue: downloadManager.snapshot() };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('queue:snapshot', async () => {
    return { ok: true, queue: downloadManager.snapshot() };
  });

  ipcMain.handle('queue:clear', async () => {
    try {
      const queue = downloadManager.clear();
      return { ok: true, queue };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('queue:pause', async (_event, { jobId }) => {
    try {
      const queue = downloadManager.pause(jobId);
      return { ok: true, queue };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('queue:resume', async (_event, { jobId }) => {
    try {
      const queue = downloadManager.resume(jobId);
      return { ok: true, queue };
    } catch (err) {
      return toIpcError(err);
    }
  });
}

function wireQueueEvents() {
  downloadManager.on('update', (queue) => {
    broadcast('queue:update', { queue });
  });
  downloadManager.on('progress', (payload) => {
    broadcast('queue:progress', payload);
  });
}

app.whenReady().then(() => {
  appSettings.init(app.getPath('userData'));
  registerIpc();
  wireQueueEvents();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
