'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { checkDeps } = require('./lib/deps');
const { analyzeVideo, downloadVideo, AppError } = require('./lib/ytdlp');

/** @type {BrowserWindow|null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 780,
    minWidth: 560,
    minHeight: 640,
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
 * Serialize AppError or generic Error for IPC.
 * @param {unknown} err
 */
function toIpcError(err) {
  if (err instanceof AppError) {
    return { ok: false, code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { ok: false, code: 'DOWNLOAD_FAILED', message: err.message };
  }
  return { ok: false, code: 'DOWNLOAD_FAILED', message: String(err) };
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

  ipcMain.handle('video:analyze', async (_event, { url }) => {
    try {
      const data = await analyzeVideo(url);
      return { ok: true, ...data };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('video:download', async (event, { url, formatId, needsAudioMerge }) => {
    try {
      const result = await downloadVideo({
        url,
        formatId,
        needsAudioMerge: needsAudioMerge !== false,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('download:progress', progress);
          }
        },
      });

      if (!event.sender.isDestroyed()) {
        event.sender.send('download:done', { path: result.path });
      }

      return { ok: true, path: result.path };
    } catch (err) {
      const payload = toIpcError(err);
      if (!event.sender.isDestroyed()) {
        event.sender.send('download:error', payload);
      }
      return payload;
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
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
