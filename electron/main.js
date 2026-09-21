const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createOpenPathBatcher, selectExternalWindow } = require('./external-open');
const { hasWindowsContextMenu, isWindowsContextMenuInstalled, setWindowsContextMenu } = require('./shell-integration');

const localAppData = process.env.LOCALAPPDATA || path.join(path.dirname(app.getPath('appData')), 'Local');
const dataDir = path.join(localAppData, 'NorwaysDiffChecker');
const preferencesPath = path.join(dataDir, 'preferences.json');
const rendererPath = path.join(__dirname, '../dist-ui/index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
const maxProbeBytes = 256 * 1024 * 1024;
const maxPreviewPixels = 100 * 1000 * 1000;
const maxConcurrentJobs = 2;
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'cache'));
let mainWindow;
const jobs = new Map();
let activeJobCount = 0;
const tabDrags = new Map();
const windowState = new Map();
function isTrustedIpc(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const source = new URL(event.senderFrame.url);
    source.hash = '';
    source.search = '';
    return source.href === rendererUrl;
  } catch { return false; }
}
function requireTrustedIpc(event) {
  if (!isTrustedIpc(event)) throw new Error('Blocked IPC from an untrusted renderer.');
}
const handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
  requireTrustedIpc(event);
  return listener(event, ...args);
});
const on = (channel, listener) => ipcMain.on(channel, (event, ...args) => {
  requireTrustedIpc(event);
  return listener(event, ...args);
});
function broadcastTabDragState(preview) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('tabs:drag-state', preview);
  }
}
function finishJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  if (job.started) activeJobCount--;
  startQueuedJobs();
}
function cancelJob(id, senderId) {
  const job = jobs.get(id);
  if (!job || (senderId !== undefined && job.senderId !== senderId)) return;
  if (!job.started) {
    jobs.delete(id);
    startQueuedJobs();
    return;
  }
  job.worker.postMessage({ kind: 'cancel' });
  job.cancelTimer = setTimeout(() => job.worker.terminate(), 5000);
  job.cancelTimer.unref();
}
function startQueuedJobs() {
  while (activeJobCount < maxConcurrentJobs) {
    const entry = [...jobs.entries()].find(([, job]) => !job.started);
    if (!entry) return;
    const [id, job] = entry;
    job.started = true;
    activeJobCount++;
    const worker = new Worker(path.join(__dirname, 'compare-worker.js'), { workerData: job.request });
    job.worker = worker;
    worker.on('message', message => {
      if (!jobs.has(id)) return;
      if (message.kind === 'result' && job.request.left?.path && job.request.right?.path) {
        const recent = { type: job.request.type, left: job.request.left.originalPath || job.request.left.path, right: job.request.right.originalPath || job.request.right.path };
        const next = settings();
        next.recentCompares = next.recentCompareLimit > 0
          ? [recent, ...next.recentCompares.filter(item => item.type !== recent.type || item.left !== recent.left || item.right !== recent.right)].slice(0, next.recentCompareLimit)
          : [];
        saveSettings(next);
      }
      if (!job.sender.isDestroyed()) job.sender.send('compare:event', { id, ...message });
      if (message.kind === 'result' || message.kind === 'error' || message.kind === 'cancelled') finishJob(id);
    });
    worker.on('error', error => {
      if (!jobs.has(id)) return;
      if (!job.sender.isDestroyed()) job.sender.send('compare:event', { id, kind: 'error', error: error.message });
      finishJob(id);
    });
    worker.on('exit', code => {
      if (!jobs.has(id)) return;
      if (!job.sender.isDestroyed()) job.sender.send('compare:event', { id, kind: 'error', error: code ? 'Comparison worker exited.' : 'Comparison stopped.' });
      finishJob(id);
    });
  }
}
const externalPaths = (argv, baseDirectory = process.cwd()) => argv.slice(1).filter(value => !value.startsWith('-')).map(value => path.resolve(baseDirectory, value)).filter(value => fs.existsSync(value) && value !== path.resolve(app.getAppPath()));
const initialOpenPaths = externalPaths(process.argv, process.cwd());
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
function flushPendingOpenRequests() {
  if (!startupOpenRequestsTaken || !pendingOpenRequests.length) return;
  const requests = pendingOpenRequests.splice(0);
  for (const request of requests) void dispatchOpenPaths(request.paths).catch(error => console.error('[external open]', error));
}
const openPathBatcher = createOpenPathBatcher((paths, mode) => {
  if (!startupOpenRequestsTaken) {
    pendingOpenRequests.push({ paths, reuseExisting: mode === 'reuse' });
    return;
  }
  void dispatchOpenPaths(paths).catch(error => console.error('[external open]', error));
});
openPathBatcher.add(initialOpenPaths, 'new');
app.on('second-instance', (_event, argv, workingDirectory) => {
  const paths = externalPaths(argv, workingDirectory);
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
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
      cancelJob(id, senderId);
    }
    let removedDrag = false;
    for (const [token, drag] of tabDrags) {
      if (drag.senderId !== senderId) continue;
      tabDrags.delete(token);
      removedDrag = true;
    }
    if (removedDrag) broadcastTabDragState(null);
    if (mainWindow === win) {
      mainWindow = BrowserWindow.getAllWindows()[0] || null;
      if (mainWindow) {
        const nextId = mainWindow.webContents.id;
        const state = windowState.get(nextId);
        if (state) windowState.set(nextId, { ...state, primary: true });
        if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('window:primary-state', true);
      }
    }
  });
  win.webContents.on('console-message', details => {
    if (details.level === 'warning' || details.level === 'error') console.error('[renderer]', details.message);
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', flushPendingOpenRequests);
  win.webContents.on('did-fail-load', (_event, code, description) => console.error('[renderer] load failure', code, description));
  win.loadFile(rendererPath);
  return win;
}
if (firstInstance) app.whenReady().then(() => {
  const shellOptions = { executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged };
  if (hasWindowsContextMenu() && !isWindowsContextMenuInstalled(shellOptions)) {
    setWindowsContextMenu(true, shellOptions);
  }
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
handle('window:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize());
handle('window:toggle-maximize', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
handle('window:is-maximized', event => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
handle('window:close', event => BrowserWindow.fromWebContents(event.sender)?.close());
handle('window:bootstrap', event => {
  const state = windowState.get(event.sender.id) || { initialTab: null, primary: false };
  windowState.set(event.sender.id, { ...state, initialTab: null });
  return state;
});
on('window:active-tab', (event, activeTab) => {
  const state = windowState.get(event.sender.id);
  if (state) windowState.set(event.sender.id, { ...state, activeTab });
});
on('tabs:begin-drag', (event, tab, tabCount) => {
  const token = randomUUID();
  tabDrags.set(token, {
    senderId: event.sender.id,
    tab: { ...tab, busy: false, progress: 0, phase: '', jobId: undefined },
    closeSource: tabCount === 1
  });
  broadcastTabDragState({ id: tab.id, title: tab.title, type: tab.type });
  event.returnValue = token;
});
handle('tabs:end-drag', (_event, token) => {
  if (tabDrags.delete(token)) broadcastTabDragState(null);
});
handle('tabs:accept-drag', (event, token) => {
  const drag = tabDrags.get(token);
  if (!drag || drag.senderId === event.sender.id) return null;
  tabDrags.delete(token);
  broadcastTabDragState(null);
  const source = BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.webContents.id === drag.senderId);
  if (source && !source.isDestroyed()) source.webContents.send('tabs:remove-transferred', drag.tab.id, drag.closeSource);
  return drag.tab;
});
handle('tabs:detach', (event, token, position) => {
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
    else if (magic.subarray(0, 4).toString() === 'PK\u0003\u0004' && stat.size <= maxProbeBytes) {
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
handle('inputs:describe', (_event, paths) => Promise.all(paths.map(describe)));
handle('inputs:startup-requests', async () => {
  await openPathBatcher.whenIdle();
  startupOpenRequestsTaken = true;
  return pendingOpenRequests.splice(0);
});
handle('inputs:browse', async (event, type) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: type === 'folders' ? ['openDirectory','multiSelections'] : ['openFile','multiSelections']
  });
  return result.canceled ? [] : Promise.all(result.filePaths.map(describe));
});
handle('inputs:text', (_event, input) => input.text !== undefined ? String(input.text) : fsp.readFile(input.path, 'utf8'));
handle('inputs:preview', async (_event, input) => {
  if (!input.path || path.extname(input.path).toLowerCase() === '.pdf') return null;
  const stat = await fsp.stat(input.path);
  if (stat.size > maxProbeBytes) throw new Error('Image preview is limited to 256 MB files.');
  const source = path.extname(input.path).toLowerCase() === '.heic'
    ? Buffer.from(await require('heic-convert')({ buffer: await fsp.readFile(input.path), format: 'PNG' })) : input.path;
  const bytes = await require('sharp')(source, { pages: 1, limitInputPixels: maxPreviewPixels }).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return 'data:image/png;base64,' + bytes.toString('base64');
});
handle('compare:start', (event, request) => {
  const id = String(request.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id) || jobs.has(id)) throw new Error('Invalid comparison job ID.');
  jobs.set(id, { worker: null, request: { ...request, id: undefined }, sender: event.sender, senderId: event.sender.id, started: false, cancelTimer: null });
  startQueuedJobs();
  return id;
});
handle('compare:cancel', (event, id) => cancelJob(id, event.sender.id));
handle('settings:get', () => settings());
handle('settings:set', (_event, patch) => {
  const next = { ...settings(), ...patch };
  next.recentCompareLimit = recentCompareLimit(next.recentCompareLimit);
  next.recentCompares = next.recentCompares.slice(0, next.recentCompareLimit);
  saveSettings(next);
  return next;
});
handle('shell-context-menu:status', () => isWindowsContextMenuInstalled({ executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged }));
handle('shell-context-menu:set', (_event, enabled) => {
  setWindowsContextMenu(Boolean(enabled), { executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged });
  return isWindowsContextMenuInstalled({ executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged });
});
handle('app-data:path', () => dataDir);
handle('app-data:open', async () => {
  const error = await shell.openPath(dataDir);
  if (error) throw new Error(error);
});
handle('external:open-url', async (_event, value) => {
  const url = new URL(String(value));
  if (url.protocol !== 'https:') throw new Error('Only secure web links can be opened.');
  await shell.openExternal(url.toString());
});
handle('app:check-for-updates', () => ({ status: 'up-to-date' }));
handle('clipboard:write-text', (_event, text) => clipboard.writeText(String(text)));
handle('export:save', async (event, request) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: request.name, filters: request.filters });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, request.base64 ? Buffer.from(request.content, 'base64') : request.content);
  return result.filePath;
});
handle('export:image-view', async (event, { title, result, options, toClipboard, flickerRight }) => {
  const png = await require('./exporters').imageViewFromComparison({ result, options, flickerRight });
  if (toClipboard) {
    clipboard.writeImage(nativeImage.createFromBuffer(png));
    return 'clipboard';
  }
  const saved = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (saved.canceled || !saved.filePath) return null;
  await fsp.writeFile(saved.filePath, png);
  return saved.filePath;
});
handle('export:text', async (event, { title, leftText, rightText, leftName, rightName, kind, fenced, toClipboard }) => {
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
handle('export:pdf', async (event, { title, lines = [], layout, leftText, rightText, chunks = [], imageView }) => {
  const saved = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (saved.canceled || !saved.filePath) return null;
  const image = imageView ? await require('./exporters').imageViewFromComparison(imageView) : undefined;
  await fsp.writeFile(saved.filePath, await require('./exporters').pdfFromComparison({ title, lines, layout, leftText, rightText, chunks, imageView: image }));
  return saved.filePath;
});
handle('export:docx', async (event, { title, chunks, tracked }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: title + (tracked ? '-tracked' : '-redline') + '.docx',
    filters: [{ name: 'Word document', extensions: ['docx'] }]
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, await require('./exporters').docxFromChunks(chunks, tracked));
  return result.filePath;
});
