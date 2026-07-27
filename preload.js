'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dropoutApi', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  prepareStems: (filePath) => ipcRenderer.invoke('stems:prepare', filePath),
  loadCached: (hash) => ipcRenderer.invoke('stems:loadCached', hash),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  removeFromLibrary: (hash) => ipcRenderer.invoke('library:remove', hash),
  pickLyrics: (hash) => ipcRenderer.invoke('lyrics:pick', hash),
  getLyrics: (hash) => ipcRenderer.invoke('lyrics:get', hash),
  backendStatus: () => ipcRenderer.invoke('backend:status'),
  onBackendProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('backend:progress', listener);
    return () => ipcRenderer.removeListener('backend:progress', listener);
  },
  fitWindow: () => ipcRenderer.invoke('window:fit'),
  readFile: async (p) => {
    const buf = await ipcRenderer.invoke('file:read', p);
    // IPC gives us a Uint8Array; hand back a clean ArrayBuffer
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('stems:progress', listener);
    return () => ipcRenderer.removeListener('stems:progress', listener);
  },
});
