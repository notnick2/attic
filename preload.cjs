const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('store', {
  load: () => ipcRenderer.invoke('board:load'),
  save: (board) => ipcRenderer.invoke('board:save', board),
  // Blocking on purpose: used while the window closes, so the last edit lands first.
  saveNow: (board) => ipcRenderer.sendSync('board:save-now', board),
});
