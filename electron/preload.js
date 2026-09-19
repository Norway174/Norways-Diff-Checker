const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = channel => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('api', {
  minimizeWindow: call('window:minimize'),
  toggleMaximizeWindow: call('window:toggle-maximize'),
  isWindowMaximized: call('window:is-maximized'),
  closeWindow: call('window:close'),
  onWindowMaximizedChange(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:maximized-state', listener);
    return () => ipcRenderer.removeListener('window:maximized-state', listener);
  },
  pathsForFiles(files) { return Array.from(files, file => webUtils.getPathForFile(file)).filter(Boolean); },
  describeInputs: call('inputs:describe'),
  browseInputs: call('inputs:browse'),
  readText: call('inputs:text'),
  preview: call('inputs:preview'),
  startCompare: call('compare:start'),
  cancelCompare: call('compare:cancel'),
  onCompareEvent(callback) {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('compare:event', listener);
    return () => ipcRenderer.removeListener('compare:event', listener);
  },
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  saveProject: call('project:save'),
  loadProject: call('project:load'),
  saveExport: call('export:save'),
  exportPdf: call('export:pdf'),
  exportDocx: call('export:docx'),
  checkUpdate: call('update:check'),
  updateNow: call('update:now'),
  updateAfterClose: call('update:defer')
});
