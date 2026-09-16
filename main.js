'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { checkDeps, bootstrapPath } = require('./lib/deps');
const { toIpcError } = require('./lib/errors');
const appSettings = require('./lib/appSettings');
const youtubeProvider = require('./lib/youtubeProvider');
const { downloadManager } = require('./lib/downloadManager');

/** @type {BrowserWindow|null} */
let mainWindow = null;

/**
 * @param {string} text
 * @param {number} [max=48]
 * @returns {string}
 */
function truncateLabel(text, max = 48) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * @param {{ url: string, title: string, type: string }} entry
 * @returns {string}
 */
function recentMenuLabel(entry) {
  const title = truncateLabel(entry.title || entry.url);
  if (entry.type === 'playlist' || entry.type === 'channel') {
    return `${title} — ${entry.type}`;
  }
  return title;
}

function rebuildAppMenu() {
  const showSettings = appSettings.getShowSettings();
  const recentEntries = appSettings.getRecentEntries();

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const recentItems =
    recentEntries.length === 0
      ? [{ label: '(empty)', enabled: false }]
      : recentEntries.map((entry) => ({
          label: recentMenuLabel(entry),
          toolTip: entry.url,
          click: () => {
            broadcast('recent:open', { url: entry.url });
          },
        }));

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Recent',
          submenu: recentItems,
        },
        {
          label: 'Clear Recent',
          enabled: recentEntries.length > 0,
          click: () => {
            appSettings.clearRecentEntries();
            rebuildAppMenu();
          },
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Show settings',
          type: 'checkbox',
          checked: showSettings,
          click: (menuItem) => {
            appSettings.setShowSettings(Boolean(menuItem.checked));
            broadcast('ui:visibility', { showSettings: appSettings.getShowSettings() });
            rebuildAppMenu();
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
    return {
      ok: true,
      ...appSettings.getSettings(),
      cookiesHealth: appSettings.getCookiesHealth(),
    };
  });

  ipcMain.handle('settings:set', async (_event, patch) => {
    try {
      const settings = appSettings.setSettings(patch || {});
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'concurrency')) {
        downloadManager.refresh();
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'showSettings')) {
        broadcast('ui:visibility', { showSettings: settings.showSettings });
        rebuildAppMenu();
      }
      return {
        ok: true,
        ...settings,
        cookiesHealth: appSettings.getCookiesHealth(),
      };
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
        return {
          ok: true,
          canceled: true,
          ...appSettings.getSettings(),
          cookiesHealth: appSettings.getCookiesHealth(),
        };
      }
      const settings = appSettings.setCookiesPath(result.filePaths[0]);
      return {
        ok: true,
        canceled: false,
        ...settings,
        cookiesHealth: appSettings.getCookiesHealth(),
      };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('settings:pickDownloadDir', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: 'Choose download folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: appSettings.getDownloadDir(),
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return {
          ok: true,
          canceled: true,
          ...appSettings.getSettings(),
          cookiesHealth: appSettings.getCookiesHealth(),
        };
      }
      const settings = appSettings.setDownloadDir(result.filePaths[0]);
      return {
        ok: true,
        canceled: false,
        ...settings,
        cookiesHealth: appSettings.getCookiesHealth(),
      };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('recent:add', async (_event, entry) => {
    try {
      const settings = appSettings.addRecentEntry(entry || {});
      rebuildAppMenu();
      return { ok: true, ...settings };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('recent:clear', async () => {
    try {
      const settings = appSettings.clearRecentEntries();
      rebuildAppMenu();
      return { ok: true, ...settings };
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

  ipcMain.handle('queue:pauseAll', async () => {
    try {
      const queue = downloadManager.pauseAll();
      return { ok: true, queue };
    } catch (err) {
      return toIpcError(err);
    }
  });

  ipcMain.handle('queue:resumeAll', async () => {
    try {
      const queue = downloadManager.resumeAll();
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
  bootstrapPath();
  appSettings.init(app.getPath('userData'));
  registerIpc();
  wireQueueEvents();
  rebuildAppMenu();
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
