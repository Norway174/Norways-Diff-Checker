const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const XLSX = require('xlsx');
const sharp = require('sharp');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norways-diff-test-'));
const workerPath = path.join(__dirname, '../electron/compare-worker.js');
function run(type, left, right, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { type, left, right, options } });
    worker.on('message', message => {
      if (message.kind === 'result') resolve(message.result);
      if (message.kind === 'error') reject(new Error(message.error));
    });
    worker.on('error', reject);
  });
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('text compares edits and respects ignore options', async () => {
  const left = { text: 'Hello\nInvoice: 123\n' }, right = { text: 'hello\nInvoice: 456\n' };
  assert.ok((await run('text', left, right)).count > 0);
  const result = await run('text', left, right, { ignoreCase: true, ignoreRules: [{ value: '123', regex: false }, { value: '456', regex: false }] });
  assert.equal(result.count, 0);
});
test('spreadsheet detects changed cells and formulas', async () => {
  const a = path.join(root, 'a.xlsx'), b = path.join(root, 'b.xlsx');
  const make = (file, formula) => {
    const sheet = XLSX.utils.aoa_to_sheet([['Label', 'Value'], ['Total', 1]]);
    sheet.B2.f = formula; sheet.B2.v = 1;
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Data'); XLSX.writeFile(book, file);
  };
  make(a, 'SUM(1)'); make(b, 'SUM(1,0)');
  const result = await run('excel', { path: a }, { path: b }, { formulas: true });
  assert.equal(result.count, 1);
});
test('folder scan reports added and modified files', async () => {
  const a = path.join(root, 'folder-a'), b = path.join(root, 'folder-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'same.txt'), 'same'); fs.writeFileSync(path.join(b, 'same.txt'), 'same');
  fs.writeFileSync(path.join(a, 'changed.txt'), 'one'); fs.writeFileSync(path.join(b, 'changed.txt'), 'two');
  fs.writeFileSync(path.join(b, 'new.txt'), 'new');
  const result = await run('folders', { path: a }, { path: b });
  assert.equal(result.count, 2);
});
test('image compare detects changed pixels', async () => {
  const a = path.join(root, 'a.png'), b = path.join(root, 'b.png');
  await sharp({ create: { width: 8, height: 8, channels: 4, background: '#000000' } }).png().toFile(a);
  await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ffffff' } }).png().toFile(b);
  const result = await run('images', { path: a }, { path: b }, { threshold: 20 });
  assert.equal(result.changed, 64);
  assert.equal(result.regions.length, 1);
});
