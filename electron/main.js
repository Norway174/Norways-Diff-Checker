const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');

const localAppData = process.env.LOCALAPPDATA || path.join(path.dirname(app.getPath('appData')), 'Local');
const dataDir = path.join(localAppData, 'NorwaysDiffChecker');
const legacyDir = path.join(dataDir, 'settings');
const preferencesPath = path.join(dataDir, 'preferences.json');
const migrationMarker = path.join(dataDir, '.settings-migrated');
fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(legacyDir) && !fs.existsSync(migrationMarker)) {
  try {
    const oldProjects = path.join(legacyDir, 'projects');
    const newProjects = path.join(dataDir, 'projects');
    const legacyPreferences = path.join(legacyDir, 'preferences.json');
    const copiedPreferences = !fs.existsSync(preferencesPath) && fs.existsSync(legacyPreferences);
    if (copiedPreferences) fs.copyFileSync(legacyPreferences, preferencesPath);
    const remapPath = value => {
      const oldPrefix = oldProjects + path.sep;
      return typeof value === 'string' && value.toLowerCase().startsWith(oldPrefix.toLowerCase())
        ? path.join(newProjects, value.slice(oldPrefix.length)) : value;
    };
    if (fs.existsSync(oldProjects)) {
      fs.cpSync(oldProjects, newProjects, { recursive: true, force: false, errorOnExist: false });
      for (const entry of fs.readdirSync(newProjects, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const projectFile = path.join(newProjects, entry.name, 'project.json');
        if (!fs.existsSync(projectFile)) continue;
        const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
        for (const tab of project.tabs || []) for (const input of [tab.left, tab.right, ...(tab.available || [])]) if (input?.path) input.path = remapPath(input.path);
        fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
      }
    }
    if (copiedPreferences && fs.existsSync(oldProjects)) {
      const migrated = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
      migrated.recentProjects = (migrated.recentProjects || []).map(item => ({ ...item, path: remapPath(item.path) }));
      for (const tab of migrated.tabs || []) for (const input of [tab.left, tab.right, ...(tab.available || [])]) if (input?.path) input.path = remapPath(input.path);
      fs.writeFileSync(preferencesPath, JSON.stringify(migrated, null, 2));
    }
    fs.writeFileSync(migrationMarker, new Date().toISOString());
  } catch (error) { console.error('Unable to migrate previous settings:', error); }
}
fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'cache'));
let mainWindow;
const jobs = new Map();
const externalPaths = argv => argv.slice(1).filter(value => !value.startsWith('-') && fs.existsSync(value) && path.resolve(value) !== path.resolve(app.getAppPath())).map(value => path.resolve(value));
let pendingOpenPaths = externalPaths(process.argv);
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', (_event, argv) => {
  pendingOpenPaths.push(...externalPaths(argv));
  if (mainWindow) {
    mainWindow.show(); mainWindow.focus();
    if (!mainWindow.webContents.isLoading() && pendingOpenPaths.length) mainWindow.webContents.send('inputs:open-paths', pendingOpenPaths.splice(0));
  }
});
const defaults = { restoreTabs: false, recentProjects: [] };
function settings() { try { return { ...defaults, ...JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) }; } catch { return defaults; } }
function saveSettings(value) {
  const tmp = preferencesPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, preferencesPath);
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 920, minHeight: 640,
    frame: false, backgroundColor: '#181818', title: 'Norways Diff Checker',
    icon: path.join(__dirname, '../assets/app-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.setMenuBarVisibility(false);
  const sendState = () => mainWindow?.webContents.send('window:maximized-state', mainWindow.isMaximized());
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);
  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const worker of jobs.values()) worker.terminate();
    jobs.clear();
  });
  mainWindow.webContents.on('console-message', details => {
    if (details.level === 'warning' || details.level === 'error') console.error('[renderer]', details.message);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => console.error('[renderer] load failure', code, description));
  mainWindow.loadFile(path.join(__dirname, '../dist-ui/index.html'));
}
if (firstInstance) app.whenReady().then(() => {
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
  if (['csv','tsv'].includes(ext)) types.push('text');
  if (ext === 'txt') types.push('excel');
  if (!types.length) throw new Error('Unsupported input: ' + path.basename(absolute));
  return { id: randomUUID(), name: path.basename(absolute), path: absolute, size: stat.size, types: [...new Set(types)] };
}
ipcMain.handle('inputs:describe', (_event, paths) => Promise.all(paths.map(describe)));
ipcMain.handle('inputs:startup-paths', () => pendingOpenPaths.splice(0));
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
  jobs.set(id, worker);
  worker.on('message', message => {
    if (!jobs.has(id)) return;
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
  const worker = jobs.get(id);
  if (!worker) return;
  jobs.delete(id);
  worker.postMessage({ kind: 'cancel' });
  setTimeout(() => worker.terminate(), 1000).unref();
});
ipcMain.handle('settings:get', () => settings());
ipcMain.handle('settings:set', (_event, patch) => { const next = { ...settings(), ...patch }; saveSettings(next); return next; });
ipcMain.handle('project:save', async (_event, project) => {
  const id = project.id || randomUUID();
  const projectDir = path.join(dataDir, 'projects', id);
  await fsp.mkdir(projectDir, { recursive: true });
  const copy = structuredClone({ ...project, id });
  for (const tab of copy.tabs || []) {
    if (tab.type === 'folders' && tab.result?.entries) tab.scanManifest = tab.result.entries.map(entry => ({
      relative: entry.relative, status: entry.status, leftHash: entry.left?.hash, rightHash: entry.right?.hash
    }));
    tab.result = null;
    tab.busy = false;
    delete tab.jobId;
    delete tab.error;
    for (const input of [tab.left, tab.right, ...(tab.available || [])]) {
      if (!input?.path || input.types?.includes('folders')) continue;
      const target = path.join(projectDir, input.id + path.extname(input.path));
      if (path.resolve(input.path) !== path.resolve(target)) {
        const staged = target + '.' + randomUUID() + '.tmp';
        try {
          await fsp.copyFile(input.path, staged);
          await fsp.rename(staged, target);
        } catch (error) { await fsp.rm(staged, { force: true }); throw error; }
      }
      input.originalPath ||= input.path;
      input.path = target;
    }
  }
  const file = path.join(projectDir, 'project.json');
  await fsp.writeFile(file, JSON.stringify(copy, null, 2));
  const next = settings();
  next.recentProjects = [{ id, name: project.name || 'Comparison', path: file }, ...next.recentProjects.filter(item => item.id !== id)].slice(0, 20);
  saveSettings(next);
  return { id, path: file };
});
ipcMain.handle('project:load', (_event, file) => fsp.readFile(file, 'utf8').then(JSON.parse));
ipcMain.handle('export:save', async (event, request) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: request.name, filters: request.filters });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, request.base64 ? Buffer.from(request.content, 'base64') : request.content);
  return result.filePath;
});
ipcMain.handle('export:pdf', async (event, { title, lines = [], layout, leftText, rightText, chunks = [] }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, await require('./exporters').pdfFromComparison({ title, lines, layout, leftText, rightText, chunks }));
  return result.filePath;
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
