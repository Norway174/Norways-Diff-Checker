const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('preload reads dropped File objects before exposing only paths to the renderer', () => {
  let onDrop;
  let api;
  const file = { path: 'C:\\example\\before.txt' };
  const code = fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8');
  vm.runInNewContext(code, {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
        ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {} },
        webUtils: { getPathForFile: value => { assert.equal(value, file); return value.path; } }
      };
    },
    document: { addEventListener: (name, listener, capture) => {
      assert.equal(name, 'drop');
      assert.equal(capture, true);
      onDrop = listener;
    } }
  });

  onDrop({ dataTransfer: { files: [file] } });
  assert.deepEqual(Array.from(api.takeDroppedPaths()), [file.path]);
  assert.deepEqual(Array.from(api.takeDroppedPaths()), []);
});
