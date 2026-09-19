const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const XLSX = require('xlsx');
const sharp = require('sharp');
const { Document, Packer, Paragraph } = require('docx');
const PDFDocument = require('pdfkit');
const JSZip = require('jszip');

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
test('spreadsheet aligns an inserted row', async () => {
  const a = path.join(root, 'rows-a.csv'), b = path.join(root, 'rows-b.csv');
  fs.writeFileSync(a, 'Name,Value\nA,1\nC,3\n');
  fs.writeFileSync(b, 'Name,Value\nA,1\nB,2\nC,3\n');
  const result = await run('excel', { path: a }, { path: b }, { alignRows: true });
  assert.equal(result.changed.length, 2);
  assert.equal(result.rowPositions[2].left, null);
  assert.equal(result.rowPositions[3].left, 3);
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
test('image compare reports separate changed regions', async () => {
  const a = path.join(root, 'regions-a.png'), b = path.join(root, 'regions-b.png');
  await sharp({ create: { width: 12, height: 12, channels: 4, background: '#ffffff' } }).png().toFile(a);
  await sharp(a).composite([
    { input: { create: { width: 2, height: 2, channels: 4, background: '#000000' } }, left: 1, top: 1 },
    { input: { create: { width: 2, height: 2, channels: 4, background: '#000000' } }, left: 9, top: 9 }
  ]).png().toFile(b);
  const result = await run('images', { path: a }, { path: b }, { threshold: 20, minRegionSize: 2 });
  assert.equal(result.count, 2);
  assert.deepEqual(result.regions.map(region => region.pixels), [4, 4]);
});
test('DOCX documents compare extracted text', async () => {
  const a = path.join(root, 'a.docx'), b = path.join(root, 'b.docx');
  fs.writeFileSync(a, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Contract is effective today')] }] })));
  fs.writeFileSync(b, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Contract is effective tomorrow')] }] })));
  const result = await run('documents', { path: a, name: 'a.docx' }, { path: b, name: 'b.docx' });
  assert.ok(result.count > 0);
});
test('PDF documents compare extracted text', async () => {
  const files = [path.join(root, 'a.pdf'), path.join(root, 'b.pdf')];
  for (let i = 0; i < 2; i++) await new Promise((resolve, reject) => {
    const pdf = new PDFDocument();
    const out = fs.createWriteStream(files[i]); out.on('finish', resolve); out.on('error', reject);
    pdf.pipe(out); pdf.text(i ? 'The new version' : 'The old version'); pdf.end();
  });
  const result = await run('documents', { path: files[0], name: 'a.pdf' }, { path: files[1], name: 'b.pdf' });
  assert.ok(result.count > 0);
  const imageResult = await run('images', { path: files[0], name: 'a.pdf' }, { path: files[1], name: 'b.pdf' }, { page: 1, threshold: 10 });
  assert.ok(imageResult.changed > 0);
});
test('PPTX slide text is extracted', async () => {
  const files = [path.join(root, 'a.pptx'), path.join(root, 'b.pptx')];
  for (let i = 0; i < 2; i++) {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="x" xmlns:a="x"><a:t>' + (i ? 'Changed' : 'Original') + '</a:t></p:sld>');
    fs.writeFileSync(files[i], await zip.generateAsync({ type: 'nodebuffer' }));
  }
  const result = await run('documents', { path: files[0], name: 'a.pptx' }, { path: files[1], name: 'b.pptx' });
  assert.ok(result.count > 0);
});
