const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const version = '26.2.6';
const downloadBytes = 373252096;
const installedBytesEstimate = 1596766810;
const downloadUrl = `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/LibreOffice_${version}_Win_x86-64.msi`;
const expectedHash = 'f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660';

function createLibreOfficeDependency({ root, request }) {
  const dependencyDir = path.join(root, 'dependencies', 'libreoffice');
  const executablePath = path.join(dependencyDir, 'program', 'soffice.exe');
  const manifestPath = path.join(dependencyDir, 'ndc-dependency.json');
  const cacheDir = path.join(root, 'dependencies', 'downloads');
  const installerPath = path.join(cacheDir, `LibreOffice_${version}_Win_x86-64.msi`);
  let activeInstall = null;

  const status = () => {
    const installed = fs.existsSync(executablePath);
    let installedBytes = installed ? installedBytesEstimate : 0;
    if (installed && fs.existsSync(manifestPath)) {
      try { installedBytes = Number(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).installedBytes) || installedBytes; }
      catch {}
    }
    return { installed, version, downloadBytes, installedBytes, installedBytesEstimate };
  };

  async function directorySize(directory) {
    let total = 0;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      total += entry.isDirectory() ? await directorySize(entryPath) : (await fsp.stat(entryPath)).size;
    }
    return total;
  }

  async function verifyInstaller() {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(installerPath);
    for await (const chunk of stream) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash) {
      await fsp.rm(installerPath, { force: true });
      throw new Error('LibreOffice download failed SHA-256 verification.');
    }
  }

  async function download(onProgress) {
    await fsp.mkdir(cacheDir, { recursive: true });
    const partialPath = installerPath + '.partial';
    await fsp.rm(partialPath, { force: true });
    await new Promise((resolve, reject) => {
      const makeRequest = (url, redirects = 0) => {
        if (redirects > 5) { reject(new Error('LibreOffice download redirected too many times.')); return; }
        const outgoing = request(url);
        outgoing.on('response', response => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            makeRequest(new URL(response.headers.location, url).toString(), redirects + 1);
            return;
          }
          if (response.statusCode !== 200) { reject(new Error(`LibreOffice download failed (${response.statusCode}).`)); return; }
          const total = Number(response.headers['content-length']) || downloadBytes;
          let received = 0;
          const output = fs.createWriteStream(partialPath);
          response.on('data', chunk => {
            received += chunk.length;
            onProgress({ phase: 'Downloading', receivedBytes: received, totalBytes: total, percent: Math.min(100, Math.round(received / total * 100)) });
          });
          response.on('error', reject);
          output.on('error', reject);
          output.on('finish', resolve);
          response.pipe(output);
        });
        outgoing.on('error', reject);
        outgoing.end();
      };
      makeRequest(downloadUrl);
    });
    await fsp.rename(partialPath, installerPath);
  }

  async function extract(onProgress) {
    const stagingDir = dependencyDir + '.installing';
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(stagingDir, { recursive: true });
    onProgress({ phase: 'Installing', receivedBytes: 0, totalBytes: installedBytesEstimate, percent: 0 });
    const logPath = path.join(cacheDir, 'libreoffice-install.log');
    await new Promise((resolve, reject) => {
      const extractedFiles = new Map();
      let extractedBytes = 0;
      let lastReport = 0;
      const watcher = fs.watch(stagingDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const filePath = path.join(stagingDir, filename);
        void fsp.stat(filePath).then(stat => {
          if (!stat.isFile()) return;
          const previousSize = extractedFiles.get(filePath) || 0;
          extractedFiles.set(filePath, stat.size);
          extractedBytes += stat.size - previousSize;
          const now = Date.now();
          if (now - lastReport < 200) return;
          lastReport = now;
          onProgress({
            phase: 'Installing',
            receivedBytes: extractedBytes,
            totalBytes: installedBytesEstimate,
            percent: Math.min(95, Math.round(extractedBytes / installedBytesEstimate * 100))
          });
        }).catch(() => {});
      });
      const child = spawn('msiexec.exe', ['/a', installerPath, `TARGETDIR=${stagingDir}`, '/qn', '/norestart', '/l*v', logPath], { windowsHide: true });
      const stopProgress = () => {
        watcher.close();
      };
      child.on('error', error => { stopProgress(); reject(error); });
      child.on('exit', code => {
        stopProgress();
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice extraction failed (${code}).`));
      });
    });
    if (!fs.existsSync(path.join(stagingDir, 'program', 'soffice.exe'))) throw new Error('LibreOffice extraction completed without soffice.exe.');
    const installedBytes = await directorySize(stagingDir);
    onProgress({ phase: 'Installing', receivedBytes: installedBytes, totalBytes: installedBytes, percent: 100 });
    await fsp.writeFile(path.join(stagingDir, 'ndc-dependency.json'), JSON.stringify({ version, installedBytes }));
    await fsp.rm(dependencyDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, dependencyDir);
  }

  async function install(onProgress = () => {}) {
    if (activeInstall) return activeInstall;
    activeInstall = (async () => {
      if (!fs.existsSync(installerPath)) await download(onProgress);
      onProgress({ phase: 'Verifying', receivedBytes: downloadBytes, totalBytes: downloadBytes, percent: 100 });
      await verifyInstaller();
      await extract(onProgress);
      await fsp.rm(installerPath, { force: true });
      onProgress({ phase: 'Complete', receivedBytes: downloadBytes, totalBytes: downloadBytes, percent: 100 });
      return status();
    })().finally(() => { activeInstall = null; });
    return activeInstall;
  }

  async function remove() {
    if (activeInstall) throw new Error('Wait for the LibreOffice installation to finish before deleting it.');
    await fsp.rm(dependencyDir, { recursive: true, force: true });
    await fsp.rm(installerPath, { force: true });
    await fsp.rm(installerPath + '.partial', { force: true });
    return status();
  }

  return { status, install, remove, executablePath };
}

module.exports = { createLibreOfficeDependency, version, downloadBytes, installedBytesEstimate };