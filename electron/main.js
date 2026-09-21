const { app, BrowserWindow, ipcMain, dialog, clipboard, ClipboardItem, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { createOpenPathBatcher, selectExternalWindow } = require('./external-open');
const { hasWindowsContextMenu, isWindowsContextMenuInstalled, setWindowsContextMenu } = require('./shell-integration');

const localAppData = process.env.LOCALAPPDATA || path.join(path.dirname(app.getPath('appData')), 'Local');
const dataDir = path.join(localAppData, 'NorwaysDiffChecker');
const preferencesPath = path.join(dataDir, 'preferences.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'cache'));
let mainWindow;
const jobs = new Map();
const tabDrags = new Map();
const windowState = new Map();
function broadcastTabDragState(preview) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('tabs:drag-state', preview);
  }
}
const externalPaths = argv => argv.slice(1).filter(value => !value.startsWith('-') && fs.existsSync(value) && path.resolve(value) !== path.resolve(app.getAppPath())).map(value => path.resolve(value));
const initialOpenPaths = externalPaths(process.argv);
let pendingOpenRequests = [];
let startupOpenRequestsTaken = false;
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
function orderedWindows() {
  const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
  const focused = BrowserWindow.getFocusedWindow();
  return focused && windows.includes(focused) ? [focused, ...windows.filter(win => win !== focused)] : windows;
}
async function dispatchOpenPaths(paths) {
  const windows = orderedWindows();
  if (!windows.length) {
    pendingOpenRequests.push({ paths, reuseExisting: true });
    return;
  }
  if (windows.every(win => win.webContents.isLoading())) {
    pendingOpenRequests.push({ paths, reuseExisting: true });
    windows[0].show();
    windows[0].focus();
    return;
  }
  let matched = null;
  if (paths.length === 1) {
    const input = await describe(paths[0]);
    matched = selectExternalWindow(windows.map(win => ({ win, activeTab: windowState.get(win.webContents.id)?.activeTab || null })), input);
  }
  const target = matched?.win || windows[0];
  target.show();
  target.focus();
  const send = () => {
    if (!target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send('inputs:open-paths', paths, matched ? 'reuse' : 'new');
  };
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send); else send();
}
const openPathBatcher = createOpenPathBatcher((paths, mode) => {
  if (!startupOpenRequestsTaken) {
    pendingOpenRequests.push({ paths, reuseExisting: mode === 'reuse' });
    return;
  }
  void dispatchOpenPaths(paths).catch(error => console.error('[external open]', error));
});
openPathBatcher.add(initialOpenPaths, 'new');
app.on('second-instance', (_event, argv) => {
  const paths = externalPaths(argv);
  if (!paths.length) return;
  openPathBatcher.add(paths);
});
const defaults = { restoreTabs: true, recentCompareLimit: 10, recentCompares: [] };
const recentCompareLimit = value => Math.max(0, Math.min(50, Math.round(Number(value) || 0)));
function settings() {
  try {
    const stored = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    const hadLegacyShellPreference = Object.prototype.hasOwnProperty.call(stored, 'shellContextMenu');
    const value = { ...defaults, ...stored };
    delete value.shellContextMenu;
    value.recentCompareLimit = recentCompareLimit(value.recentCompareLimit);
    value.recentCompares = (Array.isArray(value.recentCompares) ? value.recentCompares : []).slice(0, value.recentCompareLimit);
    if (hadLegacyShellPreference) saveSettings(value);
    return value;
  } catch { return { ...defaults }; }
}
function saveSettings(value) {
  const tmp = preferencesPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, preferencesPath);
}
function createWindow(initialTab = null, position = null) {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 920, minHeight: 640,
    ...(position ? { x: Math.round(position.x - 180), y: Math.round(position.y - 18) } : {}),
    frame: false, backgroundColor: '#181818', title: 'Norways Diff Checker',
    icon: path.join(__dirname, '../assets/app-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  if (!mainWindow) mainWindow = win;
  const senderId = win.webContents.id;
  windowState.set(senderId, { initialTab, primary: win === mainWindow, activeTab: null });
  win.setMenuBarVisibility(false);
  const sendState = () => { if (!win.isDestroyed()) win.webContents.send('window:maximized-state', win.isMaximized()); };
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  win.on('closed', () => {
    windowState.delete(senderId);
    for (const [id, job] of jobs) {
      if (job.senderId !== senderId) continue;
      job.worker.terminate();
      jobs.delete(id);
    }
    let removedDrag = false;
    for (const [token, drag] of tabDrags) {
      if (drag.senderId !== senderId) continue;
      tabDrags.delete(token);
      removedDrag = true;
    }
    if (removedDrag) broadcastTabDragState(null);
    if (mainWindow === win) mainWindow = BrowserWindow.getAllWindows()[0] || null;
  });
  win.webContents.on('console-message', details => {
    if (details.level === 'warning' || details.level === 'error') console.error('[renderer]', details.message);
  });
  win.webContents.on('did-fail-load', (_event, code, description) => console.error('[renderer] load failure', code, description));
  win.loadFile(path.join(__dirname, '../dist-ui/index.html'));
  return win;
}
if (firstInstance) app.whenReady().then(() => {
  if (hasWindowsContextMenu() && !isWindowsContextMenuInstalled()) {
    setWindowsContextMenu(true, { executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged });
  }
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
ipcMain.handle('window:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.handle('window:toggle-maximize', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:is-maximized', event => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
ipcMain.handle('window:close', event => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.handle('window:bootstrap', event => {
  const state = windowState.get(event.sender.id) || { initialTab: null, primary: false };
  windowState.set(event.sender.id, { ...state, initialTab: null });
  return state;
});
ipcMain.on('window:active-tab', (event, activeTab) => {
  const state = windowState.get(event.sender.id);
  if (state) windowState.set(event.sender.id, { ...state, activeTab });
});
ipcMain.on('tabs:begin-drag', (event, tab, tabCount) => {
  const token = randomUUID();
  tabDrags.set(token, {
    senderId: event.sender.id,
    tab: { ...tab, busy: false, progress: 0, phase: '', jobId: undefined },
    closeSource: tabCount === 1
  });
  broadcastTabDragState({ id: tab.id, title: tab.title, type: tab.type });
  event.returnValue = token;
});
ipcMain.handle('tabs:end-drag', (_event, token) => {
  if (tabDrags.delete(token)) broadcastTabDragState(null);
});
ipcMain.handle('tabs:accept-drag', (event, token) => {
  const drag = tabDrags.get(token);
  if (!drag || drag.senderId === event.sender.id) return null;
  tabDrags.delete(token);
  broadcastTabDragState(null);
  const source = BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.webContents.id === drag.senderId);
  if (source && !source.isDestroyed()) source.webContents.send('tabs:remove-transferred', drag.tab.id, drag.closeSource);
  return drag.tab;
});
ipcMain.handle('tabs:detach', (event, token, position) => {
  const drag = tabDrags.get(token);
  if (!drag || drag.senderId !== event.sender.id) return false;
  tabDrags.delete(token);
  broadcastTabDragState(null);
  createWindow(drag.tab, position);
  const source = BrowserWindow.fromWebContents(event.sender);
  if (source && !source.isDestroyed()) source.webContents.send('tabs:remove-transferred', drag.tab.id, drag.closeSource);
  return true;
});

const groups = {
  text: ['txt','md','js','jsx','ts','tsx','json','xml','yaml','yml','toml','env','log','out','err','py','java','cs','go','rs','rb','php','swift','kt','sh','sql','html','css'],
  images: ['jpg','jpeg','png','webp','gif','heic'],
  documents: ['docx','pdf','pptx'],
  excel: ['xlsx','xls','csv','tsv','ods']
};
async function describe(inputPath) {
  const absolute = path.resolve(inputPath);
  const stat = await fsp.stat(absolute);
  const ext = path.extname(absolute).slice(1).toLowerCase();
  let types = stat.isDirectory() ? ['folders'] : Object.entries(groups).filter(([,extensions]) => extensions.includes(ext)).map(([type]) => type);
  if (!stat.isDirectory()) {
    const file = await fsp.open(absolute, 'r');
    const magic = Buffer.alloc(16);
    try { await file.read(magic, 0, magic.length, 0); } finally { await file.close(); }
    if (magic.subarray(0, 5).toString() === '%PDF-') types = ['documents', 'images'];
    else if (magic.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || magic.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) || magic.subarray(0, 4).toString() === 'GIF8' || (magic.subarray(0, 4).toString() === 'RIFF' && magic.subarray(8, 12).toString() === 'WEBP') || magic.subarray(4, 12).toString().startsWith('ftypheic')) types = ['images'];
    else if (magic.subarray(0, 4).toString() === 'PK\u0003\u0004') {
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(await fsp.readFile(absolute)).catch(() => null);
      if (zip?.file('word/document.xml')) types = ['documents'];
      else if (zip?.file('ppt/presentation.xml')) types = ['documents'];
      else if (zip?.file('xl/workbook.xml') || zip?.file('content.xml')) types = ['excel'];
    }
  }
  if (types.includes('documents') && ext === 'pdf') types.push('images');
  if (ext === 'txt') types.push('excel');
  if (!stat.isDirectory()) types.push('text');
  if (!types.length) throw new Error('Unsupported input: ' + path.basename(absolute));
  return { id: randomUUID(), name: path.basename(absolute), path: absolute, size: stat.size, types: [...new Set(types)] };
}
ipcMain.handle('inputs:describe', (_event, paths) => Promise.all(paths.map(describe)));
ipcMain.handle('inputs:startup-requests', async () => {
  await openPathBatcher.whenIdle();
  startupOpenRequestsTaken = true;
  return pendingOpenRequests.splice(0);
});
ipcMain.handle('inputs:browse', async (event, type) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: type === 'folders' ? ['openDirectory','multiSelections'] : ['openFile','multiSelections']
  });
  return result.canceled ? [] : Promise.all(result.filePaths.map(describe));
});
ipcMain.handle('inputs:text', (_event, input) => input.text !== undefined ? String(input.text) : fsp.readFile(input.path, 'utf8'));
ipcMain.handle('inputs:preview', async (_event, input) => {
  if (!input.path || path.extname(input.path).toLowerCase() === '.pdf') return null;
  const source = path.extname(input.path).toLowerCase() === '.heic'
    ? Buffer.from(await require('heic-convert')({ buffer: await fsp.readFile(input.path), format: 'PNG' })) : input.path;
  const bytes = await require('sharp')(source, { pages: 1 }).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return 'data:image/png;base64,' + bytes.toString('base64');
});
ipcMain.handle('compare:start', (event, request) => {
  const id = randomUUID();
  const worker = new Worker(path.join(__dirname, 'compare-worker.js'), { workerData: request });
  jobs.set(id, { worker, senderId: event.sender.id });
  worker.on('message', message => {
    if (!jobs.has(id)) return;
    if (message.kind === 'result' && request.left?.path && request.right?.path) {
      const recent = { type: request.type, left: request.left.originalPath || request.left.path, right: request.right.originalPath || request.right.path };
      const next = settings();
      next.recentCompares = next.recentCompareLimit > 0
        ? [recent, ...next.recentCompares.filter(item => item.type !== recent.type || item.left !== recent.left || item.right !== recent.right)].slice(0, next.recentCompareLimit)
        : [];
      saveSettings(next);
    }
    if (!event.sender.isDestroyed()) event.sender.send('compare:event', { id, ...message });
    if (message.kind === 'result' || message.kind === 'error') jobs.delete(id);
  });
  worker.on('error', error => {
    jobs.delete(id);
    if (!event.sender.isDestroyed()) event.sender.send('compare:event', { id, kind: 'error', error: error.message });
  });
  worker.on('exit', code => {
    if (jobs.delete(id) && !event.sender.isDestroyed()) event.sender.send('compare:event', { id, kind: 'error', error: code ? 'Comparison worker exited.' : 'Comparison stopped.' });
  });
  return id;
});
ipcMain.handle('compare:cancel', (_event, id) => {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  job.worker.postMessage({ kind: 'cancel' });
  setTimeout(() => job.worker.terminate(), 1000).unref();
});
ipcMain.handle('settings:get', () => settings());
ipcMain.handle('settings:set', (_event, patch) => {
  const next = { ...settings(), ...patch };
  next.recentCompareLimit = recentCompareLimit(next.recentCompareLimit);
  next.recentCompares = next.recentCompares.slice(0, next.recentCompareLimit);
  saveSettings(next);
  return next;
});
ipcMain.handle('shell-context-menu:status', () => isWindowsContextMenuInstalled());
ipcMain.handle('shell-context-menu:set', (_event, enabled) => {
  setWindowsContextMenu(Boolean(enabled), { executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged });
  return isWindowsContextMenuInstalled();
});
ipcMain.handle('app-data:path', () => dataDir);
ipcMain.handle('app-data:open', async () => {
  const error = await shell.openPath(dataDir);
  if (error) throw new Error(error);
});
ipcMain.handle('external:open-url', async (_event, value) => {
  const url = new URL(String(value));
  if (url.protocol !== 'https:') throw new Error('Only secure web links can be opened.');
  await shell.openExternal(url.toString());
});
ipcMain.handle('app:check-for-updates', () => ({ status: 'up-to-date' }));
ipcMain.handle('clipboard:write-text', (_event, text) => clipboard.writeText(String(text)));
ipcMain.handle('export:save', async (event, request) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: request.name, filters: request.filters });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, request.base64 ? Buffer.from(request.content, 'base64') : request.content);
  return result.filePath;
});
ipcMain.handle('export:image-view', async (event, { title, result, options, toClipboard, flickerRight }) => {
  const png = await require('./exporters').imageViewFromComparison({ result, options, flickerRight });
  if (toClipboard) {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    return 'clipboard';
  }
  const saved = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (saved.canceled || !saved.filePath) return null;
  await fsp.writeFile(saved.filePath, png);
  return saved.filePath;
});
ipcMain.handle('export:text', async (event, { title, leftText, rightText, leftName, rightName, kind, fenced, toClipboard }) => {
  const text = require('./exporters').textFromComparison({ leftText, rightText, leftName, rightName, kind, fenced });
  if (toClipboard) {
    await clipboard.writeText(text);
    return 'clipboard';
  }
  const suggestedName = kind === 'original' ? leftName : kind === 'changed' ? rightName : title + '.diff';
  const saved = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: path.basename(suggestedName || title),
    filters: [{ name: 'All files', extensions: ['*'] }]
  });
  if (saved.canceled || !saved.filePath) return null;
  await fsp.writeFile(saved.filePath, text);
  return saved.filePath;
});
ipcMain.handle('export:pdf', async (event, { title, lines = [], layout, leftText, rightText, chunks = [], imageView }) => {
  const saved = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (saved.canceled || !saved.filePath) return null;
  const image = imageView ? await require('./exporters').imageViewFromComparison(imageView) : undefined;
  await fsp.writeFile(saved.filePath, await require('./exporters').pdfFromComparison({ title, lines, layout, leftText, rightText, chunks, imageView: image }));
  return saved.filePath;
});
ipcMain.handle('export:docx', async (event, { title, chunks, tracked }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: title + (tracked ? '-tracked' : '-redline') + '.docx',
    filters: [{ name: 'Word document', extensions: ['docx'] }]
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, await require('./exporters').docxFromChunks(chunks, tracked));
  return result.filePath;
});
