const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const home = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'NorwaysDiffChecker');
const dataDir = path.join(home, 'settings');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'electron'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
app.setPath('userData', path.join(dataDir, 'electron'));
app.setPath('sessionData', path.join(dataDir, 'cache'));
const preferencesPath = path.join(dataDir, 'preferences.json');
let mainWindow;
const jobs = new Map();
let deferredUpdate = false;
const defaults = { restoreTabs: false, skippedCommit: null, recentProjects: [] };
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
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => {
  if (deferredUpdate) launchInstaller('-update-silent');
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
ipcMain.handle('inputs:browse', async (event, type) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: type === 'folders' ? ['openDirectory','multiSelections'] : ['openFile','multiSelections']
  });
  return result.canceled ? [] : Promise.all(result.filePaths.map(describe));
});
ipcMain.handle('inputs:text', (_event, input) => input.text !== undefined ? String(input.text) : fsp.readFile(input.path, 'utf8'));
ipcMain.handle('inputs:preview', async (_event, input) => {
  if (!input.path || path.extname(input.path).toLowerCase() === '.pdf') return null;
  const bytes = await require('sharp')(input.path, { pages: 1 }).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return 'data:image/png;base64,' + bytes.toString('base64');
});
ipcMain.handle('compare:start', (event, request) => {
  const id = randomUUID();
  const worker = new Worker(path.join(__dirname, 'compare-worker.js'), { workerData: request });
  jobs.set(id, worker);
  worker.on('message', message => {
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
ipcMain.handle('compare:cancel', (_event, id) => { jobs.get(id)?.terminate(); jobs.delete(id); });
ipcMain.handle('settings:get', () => settings());
ipcMain.handle('settings:set', (_event, patch) => { const next = { ...settings(), ...patch }; saveSettings(next); return next; });
ipcMain.handle('project:save', async (_event, project) => {
  const id = project.id || randomUUID();
  const projectDir = path.join(dataDir, 'projects', id);
  await fsp.mkdir(projectDir, { recursive: true });
  const copy = structuredClone({ ...project, id });
  for (const tab of copy.tabs || []) {
    for (const input of [tab.left, tab.right, ...(tab.available || [])]) {
      if (!input?.path || input.types?.includes('folders')) continue;
      const target = path.join(projectDir, input.id + path.extname(input.path));
      if (!fs.existsSync(target)) await fsp.copyFile(input.path, target);
      input.originalPath = input.path;
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
ipcMain.handle('export:pdf', async (event, { title, lines }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath: title + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return null;
  const PDFDocument = require('pdfkit');
  await new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 40 });
    const out = fs.createWriteStream(result.filePath);
    out.on('finish', resolve); out.on('error', reject);
    pdf.pipe(out); pdf.fontSize(18).text(title); pdf.moveDown();
    for (const line of lines) pdf.fontSize(9).text(String(line));
    pdf.end();
  });
  return result.filePath;
});
ipcMain.handle('export:docx', async (event, { title, chunks, tracked }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: title + (tracked ? '-tracked' : '-redline') + '.docx',
    filters: [{ name: 'Word document', extensions: ['docx'] }]
  });
  if (result.canceled || !result.filePath) return null;
  const { Document, Packer, Paragraph } = require('docx');
  const JSZip = require('jszip');
  const base = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('')] }] }));
  const zip = await JSZip.loadAsync(base);
  let xml = await zip.file('word/document.xml').async('string');
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  let id = 1;
  const paragraphs = chunks.flatMap(chunk => {
    const lines = String(chunk.text).replace(/\n$/, '').split('\n');
    return lines.map(line => {
      const content = escape(line || ' ');
      if (tracked && chunk.type !== 'same') {
        const key = chunk.type === 'added' ? 'ins' : 'del';
        const textKey = chunk.type === 'added' ? 't' : 'delText';
        return '<w:p><w:' + key + ' w:id="' + id++ + '" w:author="Norways Diff Checker" w:date="' + new Date().toISOString() + '"><w:r><w:' + textKey + ' xml:space="preserve">' + content + '</w:' + textKey + '></w:r></w:' + key + '></w:p>';
      }
      const color = chunk.type === 'added' ? '008540' : chunk.type === 'removed' ? 'B00020' : '222222';
      const decoration = chunk.type === 'removed' ? '<w:strike/>' : chunk.type === 'added' ? '<w:u w:val="single"/>' : '';
      return '<w:p><w:r><w:rPr><w:color w:val="' + color + '"/>' + decoration + '</w:rPr><w:t xml:space="preserve">' + content + '</w:t></w:r></w:p>';
    });
  }).join('');
  xml = xml.replace(/<w:body>[\s\S]*?(<w:sectPr[\s\S]*?<\/w:sectPr>)<\/w:body>/, '<w:body>' + paragraphs + '$1</w:body>');
  zip.file('word/document.xml', xml);
  await fsp.writeFile(result.filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return result.filePath;
});
function launchInstaller(mode) {
  const file = path.join(home, 'program', 'NorwaysDiffCheckerInstaller.exe');
  if (!fs.existsSync(file)) return false;
  const copy = path.join(app.getPath('temp'), 'NorwaysDiffCheckerInstaller-' + randomUUID() + '.exe');
  fs.copyFileSync(file, copy);
  spawn(copy, [mode], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
}
ipcMain.handle('update:defer', () => { deferredUpdate = true; return true; });
ipcMain.handle('update:now', () => { if (!launchInstaller('-update')) return false; mainWindow?.close(); return true; });
ipcMain.handle('update:check', async () => {
  let marker = {};
  try { marker = JSON.parse(await fsp.readFile(path.join(dataDir, 'installed.json'), 'utf8')); } catch {}
  const installed = marker.sha;
  if (!installed) return null;
  if (marker.source === 'github' && marker.githubRepo) {
    const https = require('node:https');
    const repo = marker.githubRepo;
    const branch = marker.branch || 'main';
    const sha = await new Promise(resolve => {
      https.get('https://api.github.com/repos/' + repo + '/branches/' + branch, { headers: { 'User-Agent': 'NorwaysDiffChecker' } }, response => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => { try { resolve(JSON.parse(body).commit.sha); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    return sha && sha !== installed ? { sha, installed } : null;
  }
  const local = 'D:\\NodeJS\\Norways Diff Checker';
  const sha = await new Promise(resolve => {
    const child = spawn('git', ['-C', local, 'rev-parse', 'HEAD'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', value => out += value);
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 ? out.trim() : null));
  });
  return sha && sha !== installed ? { sha, installed } : null;
});
