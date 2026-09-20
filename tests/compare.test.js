const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const XLSX = require('xlsx');
const sharp = require('sharp');
const { Document, Packer, Paragraph, TextRun, ImageRun } = require('docx');
const PDFDocument = require('pdfkit');
const JSZip = require('jszip');
const { docxFromChunks, pdfFromComparison } = require('../electron/exporters');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norways-diff-test-'));
const workerPath = path.join(__dirname, '../electron/compare-worker.js');
function run(type, left, right, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { type, left, right, options } });
    let result;
    worker.on('message', message => {
      if (message.kind === 'result') result = message.result;
      if (message.kind === 'error') reject(new Error(message.error));
    });
    worker.on('error', reject);
    worker.on('exit', code => { if (code === 0 && result !== undefined) resolve(result); else if (code !== 0) reject(new Error('Worker exited with code ' + code)); });
  });
}
test.after(async () => {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe fixture cleanup path.');
  sharp.cache(false);
  const unlink = async file => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.unlinkSync(file); return; }
      catch (error) { if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 19) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  };
  const clean = async directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await clean(child); else await unlink(child);
    }
    fs.rmdirSync(directory);
  };
  await clean(resolved);
});
test('text compares edits and respects ignore options', async () => {
  const left = { text: 'Hello\nInvoice: 123\n' }, right = { text: 'hello\nInvoice: 456\n' };
  assert.ok((await run('text', left, right)).count > 0);
  const result = await run('text', left, right, { ignoreCase: true, ignoreRules: [{ value: '123', regex: false }, { value: '456', regex: false }] });
  assert.equal(result.count, 0);
  const regex = await run('text', { text: 'Build 123.\n' }, { text: 'Build 456.\n' }, { ignoreRules: [{ value: '\\d+', regex: true }] });
  assert.equal(regex.count, 0);
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
test('spreadsheet aligns an inserted column and retains source cell addresses', async () => {
  const a = path.join(root, 'columns-a.csv'), b = path.join(root, 'columns-b.csv');
  fs.writeFileSync(a, 'Name,Price\nA,10\n');
  fs.writeFileSync(b, 'Name,Code,Price\nA,X,10\n');
  const result = await run('excel', { path: a }, { path: b }, { alignRows: true, alignColumns: true });
  assert.equal(result.count, 2);
  assert.deepEqual(result.columnPositions, [{ left: 0, right: 0 }, { left: null, right: 1 }, { left: 1, right: 2 }]);
  assert.equal(result.changed[1].rightColumn, 1);
  assert.equal(result.changed[1].leftColumn, null);
});
test('spreadsheet cross-format pairs compare XLSX, XLS, ODS, CSV and TSV', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Value'], ['A', 1]]), 'Sheet1');
  const paths = Object.fromEntries(['xlsx', 'xls', 'ods', 'csv', 'tsv'].map(ext => [ext, path.join(root, 'formats.' + ext)]));
  for (const ext of ['xlsx', 'xls', 'ods']) XLSX.writeFile(workbook, paths[ext], { bookType: ext });
  fs.writeFileSync(paths.csv, 'Name,Value\nA,1\n');
  fs.writeFileSync(paths.tsv, 'Name\tValue\nA\t1\n');
  for (const [a, b] of [['xlsx', 'csv'], ['xls', 'ods'], ['tsv', 'xlsx']]) {
    const result = await run('excel', { path: paths[a] }, { path: paths[b] }, { alignRows: true });
    assert.equal(result.count, 0, `${a} versus ${b}`);
  }
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
test('folder exclusions match nested directories and globbed filenames', async () => {
  const a = path.join(root, 'exclude-a'), b = path.join(root, 'exclude-b');
  for (const base of [a, b]) { fs.mkdirSync(base); fs.mkdirSync(path.join(base, 'nested')); }
  fs.writeFileSync(path.join(a, 'nested', 'data.txt'), 'old'); fs.writeFileSync(path.join(b, 'nested', 'data.txt'), 'new');
  fs.writeFileSync(path.join(a, 'nested', 'debug.log'), 'old'); fs.writeFileSync(path.join(b, 'nested', 'debug.log'), 'new');
  const result = await run('folders', { path: a }, { path: b }, { exclusions: ['*.log'] });
  assert.equal(result.count, 1);
  assert.ok(result.entries.some(entry => entry.relative.endsWith('data.txt')));
  assert.ok(!result.entries.some(entry => entry.relative.endsWith('debug.log')));
  assert.equal((await run('folders', { path: a }, { path: b }, { exclusions: ['nested/**'] })).count, 0);
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
  assert.equal((await run('images', { path: a }, { path: b }, { threshold: 20, regionGap: 7 })).count, 1);
});
test('manual image offset aligns translated transparent artwork', async () => {
  const a = path.join(root, 'shift-a.png'), b = path.join(root, 'shift-b.png');
  const blank = sharp({ create: { width: 12, height: 12, channels: 4, background: '#00000000' } });
  const square = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000ff' } }).png().toBuffer();
  await blank.clone().composite([{ input: square, left: 3, top: 3 }]).png().toFile(a);
  await blank.clone().composite([{ input: square, left: 5, top: 3 }]).png().toFile(b);
  const result = await run('images', { path: a }, { path: b }, { offsetX: -2, scale: 100, threshold: 1 });
  assert.equal(result.changed, 0);
});
test('perspective adjustment changes the compared image and can be reset', async () => {
  const file = path.join(root, 'perspective.png');
  await sharp({ create: { width: 24, height: 24, channels: 4, background: '#ffffffff' } }).png().toFile(file);
  const input = { path: file };
  assert.equal((await run('images', input, input, { threshold: 1, scale: 100 })).changed, 0);
  assert.ok((await run('images', input, input, { perspectiveX: 20, perspectiveY: 10, threshold: 1, scale: 100 })).changed > 0);
});
test('HEIC decodes offline through bundled engine', async () => {
  const source = path.join(__dirname, 'fixtures', 'sample.heic');
  const result = await run('images', { path: source }, { path: source }, { threshold: 1, scale: 100 });
  assert.equal(result.changed, 0);
  assert.ok(result.width > 0 && result.height > 0);
});
test('JPG, WebP and GIF decode in image comparisons', async () => {
  const base = sharp({ create: { width: 16, height: 16, channels: 3, background: '#3478ab' } });
  const files = { jpg: path.join(root, 'codec.jpg'), webp: path.join(root, 'codec.webp'), gif: path.join(root, 'codec.gif') };
  await base.clone().jpeg().toFile(files.jpg);
  await base.clone().webp().toFile(files.webp);
  await base.clone().gif().toFile(files.gif);
  for (const file of Object.values(files)) {
    const result = await run('images', { path: file }, { path: file }, { threshold: 1, scale: 100 });
    assert.equal(result.changed, 0);
  }
});
test('DOCX documents compare extracted text', async () => {
  const a = path.join(root, 'a.docx'), b = path.join(root, 'b.docx');
  fs.writeFileSync(a, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Contract is effective today')] }] })));
  fs.writeFileSync(b, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Contract is effective tomorrow')] }] })));
  const result = await run('documents', { path: a, name: 'a.docx' }, { path: b, name: 'b.docx' });
  assert.ok(result.count > 0);
});
test('DOCX detects formatting and moved paragraphs', async () => {
  const a = path.join(root, 'format-a.docx'), b = path.join(root, 'format-b.docx');
  fs.writeFileSync(a, await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun({ text: 'Heading', bold: true })] }), new Paragraph('Alpha'), new Paragraph('Beta')
  ] }] })));
  fs.writeFileSync(b, await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun('Heading')] }), new Paragraph('Beta'), new Paragraph('Alpha')
  ] }] })));
  const result = await run('documents', { path: a, name: 'format-a.docx' }, { path: b, name: 'format-b.docx' });
  assert.ok(result.structuralChanges.some(change => change.kind === 'formatting'));
  assert.ok(result.structuralChanges.some(change => change.kind === 'moved'));
});
test('bundled LibreOffice renders DOCX pages without a system install', async () => {
  const a = path.join(root, 'render-a.docx'), b = path.join(root, 'render-b.docx');
  fs.writeFileSync(a, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Page one')] }] })));
  fs.writeFileSync(b, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Page two')] }] })));
  const result = await run('documents', { path: a, name: 'render-a.docx' }, { path: b, name: 'render-b.docx' }, { view: 'image', page: 1 });
  assert.match(result.pageImages.left, /^data:image\/png;base64,/);
  assert.match(result.pageImages.right, /^data:image\/png;base64,/);
});
test('DOCX embedded image changes are detected', async () => {
  const a = path.join(root, 'image-a.docx'), b = path.join(root, 'image-b.docx');
  for (let i = 0; i < 2; i++) {
    const png = await sharp({ create: { width: 5, height: 5, channels: 3, background: i ? '#ff0000' : '#0000ff' } }).png().toBuffer();
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new ImageRun({ data: png, transformation: { width: 5, height: 5 }, type: 'png' })] })] }] });
    fs.writeFileSync(i ? b : a, await Packer.toBuffer(doc));
  }
  const result = await run('documents', { path: a, name: 'image-a.docx' }, { path: b, name: 'image-b.docx' });
  assert.ok(result.structuralChanges.some(change => change.kind === 'image'));
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
test('protected PDF requires its password and compares locally', async () => {
  const files = [path.join(root, 'protected-a.pdf'), path.join(root, 'protected-b.pdf')];
  for (let i = 0; i < files.length; i++) await new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ userPassword: 'secret' });
    const out = fs.createWriteStream(files[i]); out.on('finish', resolve); out.on('error', reject);
    pdf.pipe(out); pdf.text(i ? 'Changed secure document' : 'Original secure document'); pdf.end();
  });
  const left = { path: files[0], name: 'protected-a.pdf' }, right = { path: files[1], name: 'protected-b.pdf' };
  await assert.rejects(run('documents', left, right), /password|encrypted/i);
  assert.ok((await run('documents', left, right, { password: 'secret' })).count > 0);
});
test('PDF page reordering appears in the structural change list', async () => {
  const files = [path.join(root, 'pages-a.pdf'), path.join(root, 'pages-b.pdf')];
  for (let i = 0; i < files.length; i++) await new Promise((resolve, reject) => {
    const pdf = new PDFDocument();
    const out = fs.createWriteStream(files[i]); out.on('finish', resolve); out.on('error', reject);
    pdf.pipe(out); pdf.text(i ? 'Second page content' : 'First page content'); pdf.addPage(); pdf.text(i ? 'First page content' : 'Second page content'); pdf.end();
  });
  const result = await run('documents', { path: files[0], name: 'pages-a.pdf' }, { path: files[1], name: 'pages-b.pdf' });
  assert.ok(result.structuralChanges.some(change => change.kind === 'moved page'));
  const reordered = await run('documents', { path: files[0], name: 'pages-a.pdf' }, { path: files[1], name: 'pages-b.pdf' }, { rightPageOrder: [2, 1] });
  assert.equal(reordered.count, 0);
});
test('scanned PDF text is read with bundled OCR', async () => {
  const files = [path.join(root, 'scan-a.pdf'), path.join(root, 'scan-b.pdf')];
  for (let i = 0; i < files.length; i++) {
    const label = i ? 'BETA' : 'ALPHA';
    const png = await sharp(Buffer.from(`<svg width="600" height="140"><rect width="600" height="140" fill="white"/><text x="30" y="100" font-size="80" font-family="Arial" fill="black">${label}</text></svg>`)).png().toBuffer();
    await new Promise((resolve, reject) => {
      const pdf = new PDFDocument({ size: [620, 180], margin: 10 });
      const out = fs.createWriteStream(files[i]); out.on('finish', resolve); out.on('error', reject);
      pdf.pipe(out); pdf.image(png, 10, 10); pdf.end();
    });
  }
  const result = await run('documents', { path: files[0], name: 'scan-a.pdf' }, { path: files[1], name: 'scan-b.pdf' }, { ocr: true });
  assert.match(result.leftText, /ALPHA/i);
  assert.match(result.rightText, /BETA/i);
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
test('Word exports reopen and tracked changes have OOXML revision tags', async () => {
  const chunks = [
    { type: 'same', text: 'A common line\n' },
    { type: 'removed', text: 'Old wording\n' },
    { type: 'added', text: 'New wording\n' }
  ];
  const tracked = await JSZip.loadAsync(await docxFromChunks(chunks, true));
  const trackedXml = await tracked.file('word/document.xml').async('string');
  assert.match(trackedXml, /<w:ins\b/);
  assert.match(trackedXml, /<w:del\b/);
  assert.match(trackedXml, /New wording/);
  const redline = await JSZip.loadAsync(await docxFromChunks(chunks, false));
  const redlineXml = await redline.file('word/document.xml').async('string');
  assert.match(redlineXml, /<w:strike\/>/);
  assert.match(redlineXml, /<w:u w:val="single"\/>/);
});
test('side-by-side and redline PDF exports reopen with expected text', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const request of [
    { title: 'Side comparison', layout: 'side', leftText: 'Original amount 10', rightText: 'Changed amount 20' },
    { title: 'Redline comparison', layout: 'redline', chunks: [{ type: 'removed', text: 'Old text\n' }, { type: 'added', text: 'New text\n' }] }
  ]) {
    const bytes = await pdfFromComparison(request);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
    assert.match(text, request.layout === 'side' ? /Original amount 10/ : /New text/);
  }
});
