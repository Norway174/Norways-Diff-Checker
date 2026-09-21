const test = require('node:test');
const assert = require('node:assert/strict');
const { commandValue, hasWindowsContextMenu, isWindowsContextMenuInstalled, menuEntries, setWindowsContextMenu } = require('../electron/shell-integration');

test('shell command launches packaged and development builds with the selected path', () => {
  assert.equal(commandValue('C:\\Program Files\\Norways Diff Checker.exe', 'D:\\source', true), '"C:\\Program Files\\Norways Diff Checker.exe" "%1"');
  assert.equal(commandValue('C:\\Electron\\electron.exe', 'D:\\source', false), '"C:\\Electron\\electron.exe" "D:\\source" "%1"');
});

test('shell integration creates file and folder menu commands', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const spawn = (file, args) => { calls.push({ file, args }); return { status: 0, stdout: '', stderr: '' }; };
  setWindowsContextMenu(true, { executablePath: 'C:\\App\\Diff.exe', appPath: 'D:\\source', packaged: true, spawn });
  assert.equal(calls.length, menuEntries.length * 6);
  assert.ok(calls.some(call => call.args.includes('Compare this file')));
  assert.ok(calls.some(call => call.args.includes('Compare this folder')));
  assert.equal(calls.filter(call => call.args.includes('MultiSelectModel') && call.args.includes('Player')).length, menuEntries.length);
  assert.equal(calls.filter(call => call.args[0] === 'query' && call.args.includes('Position')).length, menuEntries.length);
  assert.equal(calls.filter(call => call.args[0] === 'delete' && call.args.includes('Position')).length, menuEntries.length);
  assert.ok(calls.every(call => call.file === 'reg.exe'));
});

test('shell integration removes only context-menu keys that exist', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const spawn = (file, args) => {
    calls.push({ file, args });
    return { status: args[0] === 'query' && args[1] === menuEntries[1].key ? 1 : 0, stdout: '', stderr: '' };
  };
  setWindowsContextMenu(false, { executablePath: '', appPath: '', packaged: true, spawn });
  assert.equal(calls.filter(call => call.args[0] === 'query').length, 2);
  assert.deepEqual(calls.filter(call => call.args[0] === 'delete').map(call => call.args[1]), [menuEntries[0].key]);
});

test('shell integration status requires both file and folder commands', { skip: process.platform !== 'win32' }, () => {
  const installed = isWindowsContextMenuInstalled({ spawn: (_file, args) => ({
    status: args[1].startsWith(menuEntries[0].key) ? 0 : 1,
    stdout: args.includes('MultiSelectModel') ? 'MultiSelectModel    REG_SZ    Player' : ''
  }) });
  assert.equal(installed, false);
  assert.equal(isWindowsContextMenuInstalled({ spawn: (_file, args) => ({ status: 0, stdout: args.includes('MultiSelectModel') ? 'MultiSelectModel    REG_SZ    Player' : '', stderr: '' }) }), true);
  assert.equal(isWindowsContextMenuInstalled({ spawn: () => ({ status: 0, stdout: '', stderr: '' }) }), false);
});

test('shell integration detects an older registration for migration', { skip: process.platform !== 'win32' }, () => {
  assert.equal(hasWindowsContextMenu({ spawn: () => ({ status: 0, stdout: '', stderr: '' }) }), true);
  assert.equal(hasWindowsContextMenu({ spawn: (_file, args) => ({ status: args[1].startsWith(menuEntries[0].key) ? 0 : 1, stdout: '', stderr: '' }) }), false);
});