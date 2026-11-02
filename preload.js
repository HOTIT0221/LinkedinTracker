'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  db: (op, ...args) => ipcRenderer.invoke('db', op, ...args),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openDataFolder: () => ipcRenderer.invoke('open:data-folder'),
  openBackupsFolder: () => ipcRenderer.invoke('open:backups-folder'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  // auto: the one-time offer at the first start (only when HOTIT Manager has data on this PC)
  importFromHotit: (auto = false) => ipcRenderer.invoke('import:hotit', auto),
  moveDatabase: () => ipcRenderer.invoke('db:move'),
  getStartup: () => ipcRenderer.invoke('startup:get'),
  setStartup: (opts) => ipcRenderer.invoke('startup:set', opts),
  saveAttachment: (id) => ipcRenderer.invoke('attachment:save', id),
  copyAttachment: (id) => ipcRenderer.invoke('attachment:copy', id),
  // 'light' | 'dark' | 'system': the window frame, menus and Windows dialogs follow it
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  // the main process needs the password of an encrypted HOTIT Manager file: reply(password or null)
  onAskPassword: (cb) => ipcRenderer.on('ask-password', (_e, req) =>
    cb(req, (password) => ipcRenderer.send('ask-password:reply', req.id, password))),
  onDataReplaced: (cb) => ipcRenderer.on('data:replaced', (_e, data) => cb(data)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
});
