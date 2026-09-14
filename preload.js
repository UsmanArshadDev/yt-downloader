'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkDeps: () => ipcRenderer.invoke('deps:check'),

  getSettings: () => ipcRenderer.invoke('settings:get'),

  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch || {}),

  setCookiesPath: (cookiesPath) => ipcRenderer.invoke('settings:set', { cookiesPath }),

  pickCookiesFile: () => ipcRenderer.invoke('settings:pickCookiesFile'),

  analyze: (url) => ipcRenderer.invoke('url:analyze', { url }),

  loadMore: (url, start) => ipcRenderer.invoke('url:loadMore', { url, start }),

  enqueue: (jobs) => ipcRenderer.invoke('queue:enqueue', { jobs }),

  getQueue: () => ipcRenderer.invoke('queue:snapshot'),

  clearQueue: () => ipcRenderer.invoke('queue:clear'),

  pauseJob: (jobId) => ipcRenderer.invoke('queue:pause', { jobId }),

  resumeJob: (jobId) => ipcRenderer.invoke('queue:resume', { jobId }),

  onQueueUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('queue:update', listener);
    return () => ipcRenderer.removeListener('queue:update', listener);
  },

  onQueueProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('queue:progress', listener);
    return () => ipcRenderer.removeListener('queue:progress', listener);
  },
});
