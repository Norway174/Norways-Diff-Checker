const { spawnSync } = require('node:child_process');

const menuEntries = [
  { key: 'HKCU\\Software\\Classes\\*\\shell\\NorwaysDiffChecker', label: 'Compare this file' },
  { key: 'HKCU\\Software\\Classes\\Directory\\shell\\NorwaysDiffChecker', label: 'Compare this folder' }
];

function commandValue(executablePath, appPath, packaged) {
  const argumentsList = packaged ? [] : [appPath];
  return [executablePath, ...argumentsList, '%1'].map(value => `"${String(value).replaceAll('"', '\\"')}"`).join(' ');
}

function runRegistry(argumentsList, spawn = spawnSync) {
  const result = spawn('reg.exe', argumentsList, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Windows registry command failed.').trim());
}

function deleteRegistryValue(key, name, spawn = spawnSync) {
  const query = spawn('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
  if (query.error) throw query.error;
  if (query.status === 0) runRegistry(['delete', key, '/v', name, '/f'], spawn);
}

function isWindowsContextMenuInstalled({ executablePath, appPath, packaged, spawn = spawnSync } = {}) {
  if (process.platform !== 'win32') return false;
  const expectedCommand = executablePath ? commandValue(executablePath, appPath, packaged) : null;
  return menuEntries.every(entry => {
    const command = spawn('reg.exe', ['query', entry.key + '\\command', '/ve'], { encoding: 'utf8', windowsHide: true });
    if (command.error) throw command.error;
    if (command.status !== 0 || (expectedCommand && !(command.stdout || '').includes(expectedCommand))) return false;
    const multiSelect = spawn('reg.exe', ['query', entry.key, '/v', 'MultiSelectModel'], { encoding: 'utf8', windowsHide: true });
    if (multiSelect.error) throw multiSelect.error;
    return multiSelect.status === 0 && /\bPlayer\b/i.test(multiSelect.stdout || '');
  });
}

function hasWindowsContextMenu({ spawn = spawnSync } = {}) {
  if (process.platform !== 'win32') return false;
  return menuEntries.every(entry => {
    const result = spawn('reg.exe', ['query', entry.key + '\\command', '/ve'], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    return result.status === 0;
  });
}

function setWindowsContextMenu(enabled, { executablePath, appPath, packaged, spawn = spawnSync }) {
  if (process.platform !== 'win32') return;
  if (!enabled) {
    for (const entry of menuEntries) {
      const query = spawn('reg.exe', ['query', entry.key], { encoding: 'utf8', windowsHide: true });
      if (query.error) throw query.error;
      if (query.status !== 0) continue;
      runRegistry(['delete', entry.key, '/f'], spawn);
    }
    return;
  }
  const command = commandValue(executablePath, appPath, packaged);
  for (const entry of menuEntries) {
    runRegistry(['add', entry.key, '/ve', '/d', entry.label, '/f'], spawn);
    runRegistry(['add', entry.key, '/v', 'Icon', '/d', executablePath, '/f'], spawn);
    runRegistry(['add', entry.key, '/v', 'MultiSelectModel', '/d', 'Player', '/f'], spawn);
    deleteRegistryValue(entry.key, 'Position', spawn);
    runRegistry(['add', entry.key + '\\command', '/ve', '/d', command, '/f'], spawn);
  }
}

module.exports = { commandValue, hasWindowsContextMenu, isWindowsContextMenuInstalled, menuEntries, setWindowsContextMenu };