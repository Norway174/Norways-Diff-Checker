const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenPathBatcher, externalTypes, selectExternalWindow } = require('../electron/external-open');

test('external opens prefer specific comparison types over generic text', () => {
  assert.deepEqual(externalTypes({ types: ['images', 'text'] }), ['images']);
  assert.deepEqual(externalTypes({ types: ['documents', 'images', 'text'] }), ['documents', 'images']);
  assert.deepEqual(externalTypes({ types: ['excel', 'text'] }), ['excel']);
  assert.deepEqual(externalTypes({ types: ['text'] }), ['text']);
});

test('external opens only match selected one-sided tabs across windows', () => {
  const windows = [
    { id: 'text', activeTab: { type: 'text', left: true, right: false } },
    { id: 'complete-image', activeTab: { type: 'images', left: true, right: true } },
    { id: 'image', activeTab: { type: 'images', left: false, right: true } }
  ];
  assert.equal(selectExternalWindow(windows, { types: ['images', 'text'] }).id, 'image');
  assert.equal(selectExternalWindow(windows, { types: ['documents', 'text'] }), null);
});

test('external open batcher merges shell launches into one ordered request', async () => {
  const batches = [];
  const batcher = createOpenPathBatcher((paths, mode) => batches.push({ paths, mode }), 5);
  batcher.add(['C:\\one.txt'], 'new');
  batcher.add(['C:\\two.txt']);
  batcher.add(['C:\\one.txt', 'C:\\three.txt']);
  await batcher.whenIdle();
  assert.deepEqual(batches, [{ paths: ['C:\\one.txt', 'C:\\two.txt', 'C:\\three.txt'], mode: 'new' }]);
});

test('external open batcher separates launches after the idle window', async () => {
  const batches = [];
  const batcher = createOpenPathBatcher((paths, mode) => batches.push({ paths, mode }), 5);
  batcher.add(['C:\\one.txt']);
  await batcher.whenIdle();
  batcher.add(['C:\\two.txt']);
  await batcher.whenIdle();
  assert.deepEqual(batches, [
    { paths: ['C:\\one.txt'], mode: 'reuse' },
    { paths: ['C:\\two.txt'], mode: 'reuse' }
  ]);
});