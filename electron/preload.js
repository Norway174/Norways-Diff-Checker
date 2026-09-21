const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = channel => (...args) => ipcRenderer.invoke(channel, ...args);
let droppedPaths = [];
document.addEventListener('drop', event => {
  droppedPaths = Array.from(event.dataTransfer?.files || [], file => webUtils.getPathForFile(file)).filter(Boolean);
}, true);
contextBridge.exposeInMainWorld('api', {
  minimizeWindow: call('window:minimize'),
  toggleMaximizeWindow: call('window:toggle-maximize'),
  isWindowMaximized: call('window:is-maximized'),
  closeWindow: call('window:close'),
  takeWindowBootstrap: call('window:bootstrap'),
  reportActiveTab(activeTab) { ipcRenderer.send('window:active-tab', activeTab); },
  beginTabDrag(tab, tabCount) { return ipcRenderer.sendSync('tabs:begin-drag', tab, tabCount); },
  endTabDrag: call('tabs:end-drag'),
  acceptTabDrag: call('tabs:accept-drag'),
  detachTab: call('tabs:detach'),
  onRemoveTransferredTab(callback) {
    const listener = (_event, id, closeWindow) => callback(id, closeWindow);
    ipcRenderer.on('tabs:remove-transferred', listener);
    return () => ipcRenderer.removeListener('tabs:remove-transferred', listener);
  },
  onTabDragState(callback) {
    const listener = (_event, preview) => callback(preview);
    ipcRenderer.on('tabs:drag-state', listener);
    return () => ipcRenderer.removeListener('tabs:drag-state', listener);
  },
  onWindowMaximizedChange(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:maximized-state', listener);
    return () => ipcRenderer.removeListener('window:maximized-state', listener);
  },
  takeDroppedPaths() { const paths = droppedPaths; droppedPaths = []; return paths; },
  describeInputs: call('inputs:describe'),
  takeStartupOpenRequests: call('inputs:startup-requests'),
  onOpenPaths(callback) {
    const listener = (_event, paths, mode) => callback(paths, mode);
    ipcRenderer.on('inputs:open-paths', listener);
    return () => ipcRenderer.removeListener('inputs:open-paths', listener);
  },
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
  getShellContextMenuInstalled: call('shell-context-menu:status'),
  setShellContextMenuInstalled: call('shell-context-menu:set'),
  getAppDataPath: call('app-data:path'),
  openAppDataFolder: call('app-data:open'),
  openExternalUrl: call('external:open-url'),
  checkForUpdates: call('app:check-for-updates'),
  writeClipboardText: call('clipboard:write-text'),
  saveExport: call('export:save'),
  exportImageView: call('export:image-view'),
  exportText: call('export:text'),
  exportPdf: call('export:pdf'),
  exportDocx: call('export:docx')
});
