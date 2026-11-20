// Preload bridge between the app's pages and the desktop shell (CommonJS: preloads run sandboxed).
// Exposes window.lupixisDesktop. Pages work without it too (plain browser), they just hide desktop-only UI.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lupixisDesktop', {
  // floating window
  minimize: () => ipcRenderer.send('floating:minimize'),
  close: () => ipcRenderer.send('floating:close'),
  dragStart: () => ipcRenderer.send('floating:drag-start'),
  dragEnd: () => ipcRenderer.send('floating:drag-end'),

  toggleFullscreen: () => ipcRenderer.send('controller:fullscreen'),
  closeOutput: () => ipcRenderer.send('output:close'), // fullscreen output windows: Esc closes them

  // this computer: floating window, fullscreen outputs, which timer we're connected to
  info: () => ipcRenderer.invoke('desktop:info'),
  command: (name, params) => ipcRenderer.invoke('desktop:command', name, params),
  onUpdate: (fn) => {
    const handler = (_e, info) => fn(info);
    ipcRenderer.on('desktop:update', handler);
    return () => ipcRenderer.off('desktop:update', handler);
  },
});
