const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, protocol, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createOpenPathBatcher, selectExternalWindow } = require('./external-open');
const { hasWindowsContextMenu, isWindowsContextMenuInstalled, setWindowsContextMenu } = require('./shell-integration');
const { createLibreOfficeDependency } = require('./libreoffice-dependency');
const limits = require('./limits');

const localAppData = process.env.LOCALAPPDATA || path.join(path.dirname(app.getPath('appData')), 'Local');
const dataDir = path.join(localAppData, 'NorwaysDiffChecker');
const preferencesPath = path.join(dataDir, 'preferences.json');
const maintenancePaths = [
  path.join(dataDir, 'NorwaysDiffCheckerInstaller.exe'),
  path.join(dataDir, 'NorwaysDiffCheckerInstaller.bat')
];
const comparisonAssetsDir = path.join(dataDir, 'cache', 'comparison-assets');
const rendererPath = path.join(__dirname, '../dist-ui/index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
const maxProbeBytes = 256 * 1024 * 1024;
const maxPreviewPixels = 100 * 1000 * 1000;
const maxConcurrentJobs = 2;
const maxQueuedJobs = 100;
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
fs.rmSync(comparisonAssetsDir, { recursive: true, force: true });
fs.mkdirSync(comparisonAssetsDir, { recursive: true });
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'cache'));
const libreOffice = createLibreOfficeDependency({ root: dataDir, request: net.request });
protocol.registerSchemesAsPrivileged([{ scheme: 'ndc-asset', privileges: { secure: true, standard: true, supportFetchAPI: true } }]);
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
  if (job.cancelTimer) clearTimeout(job.cancelTimer);
  jobs.delete(id);
  if (job.started) activeJobCount--;
  startQueuedJobs();
}
function removeComparisonAssets(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
  void fsp.rm(path.join(comparisonAssetsDir, id), { recursive: true, force: true }).catch(error => console.error('[asset cleanup]', error));
}
function runExportWorker(kind, payload, destination) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'export-worker.js'), { workerData: { kind, payload, destination, assetRoot: comparisonAssetsDir } });
    worker.once('message', message => {
      if (message.kind === 'error') reject(new Error(message.error));
      else resolve(message.output);
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (code) reject(new Error('Export worker exited unexpectedly.')); });
  });
}
function cancelJob(id, senderId) {
  const job = jobs.get(id);
  if (!job || (senderId !== undefined && job.senderId !== senderId)) return;
  if (!job.started) {
    jobs.delete(id);
    removeComparisonAssets(job.request.assetId);
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
    const worker = new Worker(path.join(__dirname, 'compare-worker.js'), { workerData: { ...job.request, libreOfficePath: libreOffice.status().installed ? libreOffice.executablePath : null } });
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
      else if (message.kind === 'result') removeComparisonAssets(job.request.assetId);
      if (message.kind === 'error' || message.kind === 'cancelled') removeComparisonAssets(job.request.assetId);
      if (message.kind === 'result' || message.kind === 'error' || message.kind === 'cancelled') finishJob(id);
    });
    worker.on('error', error => {
      if (!jobs.has(id)) return;
      if (!job.sender.isDestroyed()) job.sender.send('compare:event', { id, kind: 'error', error: error.message });
      removeComparisonAssets(job.request.assetId);
      finishJob(id);
    });
    worker.on('exit', code => {
      if (!jobs.has(id)) return;
      if (!job.sender.isDestroyed()) job.sender.send('compare:event', { id, kind: 'error', error: code ? 'Comparison worker exited.' : 'Comparison stopped.' });
      removeComparisonAssets(job.request.assetId);
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
const modes = ['text', 'images', 'documents', 'excel', 'folders'];
const recentCompareLimit = value => Math.max(0, Math.min(50, Math.round(Number(value) || 0)));
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
function limitedString(value, maximum, label) {
  const text = String(value ?? '');
  if (text.length > maximum) throw new Error(`${label} is too large.`);
  return text;
}
function transferInput(input) {
  if (!plainObject(input)) return null;
  if (typeof input.path === 'string') return sanitizeStoredInput(input);
  if (input.text === undefined) return null;
  const text = String(input.text);
  if (Buffer.byteLength(text) > limits.maxInlineTextBytes) throw new Error('Pasted text is limited to 64 MB.');
  return { id: String(input.id || randomUUID()), name: limitedString(input.name || 'Pasted text', 512, 'Input name'), types: Array.isArray(input.types) ? input.types.filter(type => modes.includes(type)).slice(0, 5) : ['text'], text };
}
function sanitizeStoredInput(input) {
  if (!plainObject(input) || typeof input.path !== 'string' || input.path.length > limits.maxPathLength) return null;
  return { id: String(input.id || randomUUID()), name: String(input.name || path.basename(input.path)).slice(0, 512), path: input.path, originalPath: typeof input.originalPath === 'string' ? input.originalPath : undefined, size: Number(input.size) || undefined, types: Array.isArray(input.types) ? input.types.filter(type => Object.hasOwn(groups, type) || type === 'folders').slice(0, 5) : ['text'] };
}
function sanitizeStoredOptions(options) {
  if (!plainObject(options)) return {};
  const next = { ...options };
  delete next.password;
  return next;
}
function sanitizeStoredTab(tab) {
  if (!plainObject(tab) || !modes.includes(tab.type)) return null;
  return {
    id: String(tab.id || randomUUID()), title: String(tab.title || tab.type).slice(0, 512), type: tab.type,
    left: sanitizeStoredInput(tab.left), right: sanitizeStoredInput(tab.right),
    available: (Array.isArray(tab.available) ? tab.available : []).map(sanitizeStoredInput).filter(Boolean).slice(0, limits.maxPathsPerRequest),
    options: sanitizeStoredOptions(tab.options), result: null, busy: false, progress: 0, phase: '',
    scans: (Array.isArray(tab.scans) ? tab.scans : []).slice(-50).map(scan => ({ ...scan, options: sanitizeStoredOptions(scan?.options) })),
    decisions: plainObject(tab.decisions) ? tab.decisions : undefined
  };
}
function sanitizeTransferredTab(tab) {
  if (!plainObject(tab) || !modes.includes(tab.type)) throw new Error('Invalid transferred tab.');
  return {
    id: String(tab.id || randomUUID()), title: limitedString(tab.title || tab.type, 512, 'Tab title'), type: tab.type,
    left: transferInput(tab.left), right: transferInput(tab.right),
    available: (Array.isArray(tab.available) ? tab.available : []).map(transferInput).filter(Boolean).slice(0, limits.maxPathsPerRequest),
    options: sanitizeStoredOptions(tab.options), result: null, busy: false, progress: 0, phase: '', needsCompare: Boolean(tab.left && tab.right),
    scans: (Array.isArray(tab.scans) ? tab.scans : []).slice(-50).map(scan => ({ ...scan, options: sanitizeStoredOptions(scan?.options) })),
    decisions: plainObject(tab.decisions) ? tab.decisions : undefined
  };
}
function sanitizeSettings(value) {
  const source = plainObject(value) ? value : {};
  const recentLimit = recentCompareLimit(source.recentCompareLimit ?? defaults.recentCompareLimit);
  return {
    ...defaults,
    restoreTabs: source.restoreTabs !== false,
    recentCompareLimit: recentLimit,
    recentCompares: (Array.isArray(source.recentCompares) ? source.recentCompares : []).filter(item => plainObject(item) && ['text', 'images', 'documents', 'excel', 'folders'].includes(item.type) && typeof item.left === 'string' && typeof item.right === 'string').slice(0, recentLimit).map(item => ({ type: item.type, left: item.left.slice(0, limits.maxPathLength), right: item.right.slice(0, limits.maxPathLength) })),
    lastImageView: typeof source.lastImageView === 'string' ? source.lastImageView.slice(0, 32) : undefined,
    tabs: (Array.isArray(source.tabs) ? source.tabs : []).map(sanitizeStoredTab).filter(Boolean).slice(0, 100),
    activeTabId: typeof source.activeTabId === 'string' ? source.activeTabId : undefined
  };
}
function settings() {
  const backup = preferencesPath + '.bak';
  try {
    const stored = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    const hadLegacyShellPreference = Object.prototype.hasOwnProperty.call(stored, 'shellContextMenu');
    const value = sanitizeSettings(stored);
    const comparable = { ...stored };
    delete comparable.shellContextMenu;
    if (hadLegacyShellPreference || JSON.stringify(value) !== JSON.stringify(comparable)) saveSettings(value);
    return value;
  } catch (error) {
    if (fs.existsSync(preferencesPath)) console.error('[settings] unable to read preferences', error);
    try { return sanitizeSettings(JSON.parse(fs.readFileSync(backup, 'utf8'))); }
    catch { return sanitizeSettings(defaults); }
  }
}
function saveSettings(value) {
  const tmp = preferencesPath + '.tmp';
  const backup = preferencesPath + '.bak';
  const sanitized = sanitizeSettings(value);
  fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2));
  if (fs.existsSync(preferencesPath)) {
    try {
      const previous = sanitizeSettings(JSON.parse(fs.readFileSync(preferencesPath, 'utf8')));
      fs.writeFileSync(backup, JSON.stringify(previous, null, 2));
    }
    catch {}
  }
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
  protocol.handle('ndc-asset', request => {
    const url = new URL(request.url);
    const id = url.hostname;
    const name = path.basename(decodeURIComponent(url.pathname));
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[a-z0-9-]+\.png$/i.test(name)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(comparisonAssetsDir, id, name)).href);
  });
  const shellOptions = { executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged };
  try {
    if (hasWindowsContextMenu() && !isWindowsContextMenuInstalled(shellOptions)) setWindowsContextMenu(true, shellOptions);
  } catch (error) { console.error('[shell integration]', error); }
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
on('tabs:begin-drag', (event, token, tab, tabCount) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(token)) || tabDrags.has(token) || !tab || typeof tab !== 'object') return;
  let transferred;
  try { transferred = sanitizeTransferredTab(tab); }
  catch { return; }
  tabDrags.set(token, {
    senderId: event.sender.id,
    tab: transferred,
    closeSource: tabCount === 1
  });
  broadcastTabDragState({ id: tab.id, title: tab.title, type: tab.type });
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
handle('inputs:describe', (_event, paths) => {
  if (!Array.isArray(paths) || paths.length > limits.maxPathsPerRequest || paths.some(value => typeof value !== 'string' || value.length > limits.maxPathLength)) throw new Error('Invalid input paths.');
  return Promise.all(paths.map(describe));
});
handle('inputs:startup-requests', async () => {
  await openPathBatcher.whenIdle();
  startupOpenRequestsTaken = true;
  return pendingOpenRequests.splice(0);
});
handle('inputs:browse', async (event, type) => {
  if (!modes.includes(type)) throw new Error('Invalid comparison type.');
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: type === 'folders' ? ['openDirectory','multiSelections'] : ['openFile','multiSelections']
  });
  return result.canceled ? [] : Promise.all(result.filePaths.map(describe));
});
handle('inputs:text', async (_event, input) => {
  if (input?.text !== undefined) {
    const text = String(input.text);
    if (Buffer.byteLength(text) > limits.maxInlineTextBytes) throw new Error('Pasted text is limited to 64 MB.');
    return text;
  }
  if (!input?.path || typeof input.path !== 'string') throw new Error('Invalid text input.');
  const stat = await fsp.stat(input.path);
  if (stat.size > limits.maxTextFileBytes) throw new Error('Text and binary comparison is limited to 512 MB per file.');
  return fsp.readFile(input.path, 'utf8');
});
handle('inputs:preview', async (_event, input) => {
  if (!plainObject(input) || typeof input.path !== 'string' || input.path.length > limits.maxPathLength) throw new Error('Invalid preview input.');
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
  if (jobs.size >= maxQueuedJobs) throw new Error('Too many comparisons are queued. Cancel or finish an existing comparison first.');
  if (!plainObject(request) || !['text', 'images', 'documents', 'excel', 'folders'].includes(request.type) || !plainObject(request.options)) throw new Error('Invalid comparison request.');
  for (const input of [request.left, request.right]) {
    if (!plainObject(input) || (typeof input.path !== 'string' && input.text === undefined)) throw new Error('Invalid comparison input.');
    if (typeof input.path === 'string' && input.path.length > limits.maxPathLength) throw new Error('Input path is too long.');
    if (input.text !== undefined && Buffer.byteLength(String(input.text)) > limits.maxInlineTextBytes) throw new Error('Pasted text is limited to 64 MB.');
  }
  const assetId = request.type === 'images' ? id : undefined;
  const assetDir = assetId ? path.join(comparisonAssetsDir, assetId) : undefined;
  if (assetDir) fs.mkdirSync(assetDir, { recursive: true });
  jobs.set(id, { worker: null, request: { ...request, id: undefined, assetId, assetDir }, sender: event.sender, senderId: event.sender.id, started: false, cancelTimer: null });
  startQueuedJobs();
  return id;
});
handle('compare:cancel', (event, id) => cancelJob(id, event.sender.id));
handle('compare:release-assets', (_event, id) => removeComparisonAssets(id));
handle('settings:get', () => settings());
handle('settings:set', (_event, patch) => {
  if (!plainObject(patch)) throw new Error('Invalid settings update.');
  const allowed = new Set(['restoreTabs', 'recentCompareLimit', 'recentCompares', 'lastImageView', 'tabs', 'activeTabId']);
  const filtered = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
  const next = sanitizeSettings({ ...settings(), ...filtered });
  saveSettings(next);
  return next;
});
handle('shell-context-menu:status', () => isWindowsContextMenuInstalled({ executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged }));
handle('shell-context-menu:set', (_event, enabled) => {
  setWindowsContextMenu(Boolean(enabled), { executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged });
  return isWindowsContextMenuInstalled({ executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged });
});
handle('dependency:libreoffice:status', () => libreOffice.status());
handle('dependency:libreoffice:install', async event => libreOffice.install(progress => {
  if (!event.sender.isDestroyed()) event.sender.send('dependency:libreoffice:progress', progress);
}));
handle('dependency:libreoffice:delete', () => libreOffice.remove());
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
handle('app:open-maintenance', () => {
  if (process.platform !== 'win32') throw new Error('The maintenance tool is only available on Windows.');
  const maintenancePath = maintenancePaths.find(candidate => fs.existsSync(candidate));
  if (!maintenancePath) throw new Error('The maintenance tool is not installed. Download the installer from the project README.');
  const legacyBatch = path.extname(maintenancePath).toLowerCase() === '.bat';
  const child = spawn(legacyBatch ? (process.env.ComSpec || 'cmd.exe') : maintenancePath, legacyBatch ? ['/d', '/s', '/c', `start "" "${maintenancePath}"`] : [], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return { status: 'opened' };
});
handle('clipboard:write-text', (_event, text) => clipboard.writeText(limitedString(text, limits.maxInlineTextBytes, 'Clipboard text')));
handle('export:image-view', async (event, { title, result, options, toClipboard, flickerRight }) => {
  if (!plainObject(result) || !plainObject(options) || !/^[0-9a-f-]{36}$/i.test(String(result.assetId || ''))) throw new Error('Invalid image export.');
  title = limitedString(title, 512, 'Export title');
  if (toClipboard) {
    const png = await runExportWorker('image', { result, options, flickerRight });
    clipboard.writeImage(nativeImage.createFromBuffer(png));
    return 'clipboard';
  }
  const saved = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (saved.canceled || !saved.filePath) return null;
  await runExportWorker('image', { result, options, flickerRight }, saved.filePath);
  return saved.filePath;
});
handle('export:text', async (event, { title, leftText, rightText, leftName, rightName, kind, fenced, toClipboard }) => {
  title = limitedString(title, 512, 'Export title');
  leftText = limitedString(leftText, limits.maxTextFileBytes, 'Original text');
  rightText = limitedString(rightText, limits.maxTextFileBytes, 'Changed text');
  if (!['original', 'changed', 'unified'].includes(kind)) throw new Error('Invalid text export type.');
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
  title = limitedString(title, 512, 'Export title');
  if (!Array.isArray(lines) || !Array.isArray(chunks) || lines.length > 100000 || chunks.length > 100000) throw new Error('PDF export is too large.');
  const saved = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (saved.canceled || !saved.filePath) return null;
  await runExportWorker('pdf', { title, lines, layout, leftText, rightText, chunks, imageView }, saved.filePath);
  return saved.filePath;
});
handle('export:docx', async (event, { title, chunks, tracked }) => {
  title = limitedString(title, 512, 'Export title');
  if (!Array.isArray(chunks) || chunks.length > 100000) throw new Error('Word export is too large.');
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: title + (tracked ? '-tracked' : '-redline') + '.docx',
    filters: [{ name: 'Word document', extensions: ['docx'] }]
  });
  if (result.canceled || !result.filePath) return null;
  await runExportWorker('docx', { chunks, tracked: Boolean(tracked) }, result.filePath);
  return result.filePath;
});
handle('export:xlsx', async (event, { title, rows }) => {
  title = limitedString(title, 512, 'Export title');
  if (!Array.isArray(rows) || rows.length > limits.maxSpreadsheetCells) throw new Error('Spreadsheet export is too large.');
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
  if (result.canceled || !result.filePath) return null;
  await runExportWorker('xlsx', { rows }, result.filePath);
  return result.filePath;
});
