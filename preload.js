'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkDeps: () => ipcRenderer.invoke('deps:check'),

  analyze: (url) => ipcRenderer.invoke('video:analyze', { url }),

  download: (url, formatId, needsAudioMerge) =>
    ipcRenderer.invoke('video:download', { url, formatId, needsAudioMerge }),

  onDownloadProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },

  onDownloadDone: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download:done', listener);
    return () => ipcRenderer.removeListener('download:done', listener);
  },

  onDownloadError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download:error', listener);
    return () => ipcRenderer.removeListener('download:error', listener);
  },
});
