const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Diff = require('diff');
const XLSX = require('xlsx');
const sharp = require('sharp');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const exifr = require('exifr');

const report = (value, phase) => parentPort.postMessage({ kind: 'progress', value, phase });
const request = workerData;
function normalize(value, options = {}) {
  let text = String(value).replace(/\r\n/g, '\n');
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const rule of options.ignoreRules || []) {
    if (!rule.value) continue;
    try { text = text.replace(new RegExp(rule.regex ? rule.value : escapeRegex(rule.value), 'g'), ''); } catch {}
  }
  if (options.ignoreWhitespace) text = text.replace(/[ \t]+/g, ' ');
  if (options.ignoreCase) text = text.toLowerCase();
  return text;
}
function textDiff(leftText, rightText, options = {}) {
  const left = normalize(leftText, options), right = normalize(rightText, options);
  const parts = options.precision === 'character' ? Diff.diffChars(left, right)
    : options.precision === 'word' ? Diff.diffWordsWithSpace(left, right)
    : Diff.diffLines(left, right);
  let leftLine = 1, rightLine = 1, leftOffset = 0, rightOffset = 0;
  const chunks = parts.map(part => {
    const lines = part.value.replace(/\n$/, '').split('\n');
    const chunk = { type: part.added ? 'added' : part.removed ? 'removed' : 'same', text: part.value, lines, leftLine, rightLine, leftOffset, rightOffset };
    const advance = options.precision === 'character' || options.precision === 'word'
      ? (part.value.match(/\n/g) || []).length : lines.length;
    if (!part.added) leftLine += advance;
    if (!part.removed) rightLine += advance;
    if (!part.added) leftOffset += part.value.length;
    if (!part.removed) rightOffset += part.value.length;
    return chunk;
  });
  return { leftText, rightText, chunks, count: chunks.filter(x => x.type !== 'same').length };
}
async function loadText(input) {
  return input.text !== undefined ? String(input.text) : fsp.readFile(input.path, 'utf8');
}
async function compareText() {
  report(15, 'Reading text');
  const [left, right] = await Promise.all([loadText(request.left), loadText(request.right)]);
  report(70, 'Finding changes');
  return textDiff(left, right, request.options);
}
function sheetRows(sheet) {
  const ref = sheet['!ref'] || 'A1';
  const bounds = XLSX.utils.decode_range(ref);
  const rows = [];
  for (let row = bounds.s.r; row <= bounds.e.r; row++) {
    const values = [];
    for (let col = bounds.s.c; col <= bounds.e.c; col++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      values.push({ value: cell?.v ?? '', display: cell?.w ?? String(cell?.v ?? ''), formula: cell?.f || '' });
    }
    rows.push(values);
  }
  return rows;
}
function cellValue(cell, options) {
  let value = options.formulas && cell.formula ? '=' + cell.formula : cell.display;
  if (options.dateOrder !== 'none' && /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}$/.test(value)) {
    const [first, second, year] = value.split(/[/.\-]/).map(Number);
    const month = options.dateOrder === 'US' ? first : second;
    const day = options.dateOrder === 'US' ? second : first;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (options.ignoreWhitespace) value = value.trim().replace(/\s+/g, ' ');
  if (options.ignoreCase) value = value.toLowerCase();
  return value;
}
async function compareExcel() {
  report(10, 'Reading spreadsheets');
  const [left, right] = await Promise.all([request.left, request.right].map(async input => XLSX.read(await fsp.readFile(input.path), { type: 'buffer', cellFormula: true, cellDates: true })));
  const leftName = request.options.leftSheet || left.SheetNames[0];
  const rightName = request.options.rightSheet || right.SheetNames[0];
  let leftRows = sheetRows(left.Sheets[leftName] || left.Sheets[left.SheetNames[0]]);
  let rightRows = sheetRows(right.Sheets[rightName] || right.Sheets[right.SheetNames[0]]);
  const rowPositions = [];
  if (request.options.alignRows !== false) {
    const key = row => cellValue(row[0] || { display: '', formula: '' }, request.options) || row.map(cell => cellValue(cell, request.options)).join('\u0001');
    const parts = Diff.diffArrays(leftRows.map(key), rightRows.map(key));
    const pairedLeft = [], pairedRight = [];
    let l = 0, r = 0;
    for (let index = 0; index < parts.length;) {
      if (!parts[index].added && !parts[index].removed) {
        for (let count = 0; count < parts[index].value.length; count++) {
          pairedLeft.push(leftRows[l++]); pairedRight.push(rightRows[r++]); rowPositions.push({ left: l, right: r });
        }
        index++;
      } else {
        let removed = 0, added = 0;
        while (index < parts.length && (parts[index].added || parts[index].removed)) {
          if (parts[index].removed) removed += parts[index].value.length;
          if (parts[index].added) added += parts[index].value.length;
          index++;
        }
        for (let count = 0; count < Math.max(removed, added); count++) {
          pairedLeft.push(count < removed ? leftRows[l++] : []);
          pairedRight.push(count < added ? rightRows[r++] : []);
          rowPositions.push({ left: count < removed ? l : null, right: count < added ? r : null });
        }
      }
    }
    leftRows = pairedLeft; rightRows = pairedRight;
  }
  report(70, 'Finding cell changes');
  const changed = [];
  for (let row = 0; row < Math.max(leftRows.length, rightRows.length); row++) {
    for (let col = 0; col < Math.max(leftRows[row]?.length || 0, rightRows[row]?.length || 0); col++) {
      const a = leftRows[row]?.[col], b = rightRows[row]?.[col];
      if (cellValue(a || { display: '', formula: '' }, request.options) !== cellValue(b || { display: '', formula: '' }, request.options)) changed.push({ row, col, left: a?.display ?? '', right: b?.display ?? '', leftFormula: a?.formula ?? '', rightFormula: b?.formula ?? '', leftRow: rowPositions[row]?.left ?? null, rightRow: rowPositions[row]?.right ?? null });
    }
  }
  return { leftSheets: left.SheetNames, rightSheets: right.SheetNames, leftName, rightName, leftRows, rightRows, rowPositions, changed, count: changed.length,
    details: [{ label: 'Sheets', left: left.SheetNames.length, right: right.SheetNames.length }, { label: 'Rows', left: leftRows.length, right: rightRows.length }] };
}
async function hash(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}
async function scanFolder(root, ignored, result = new Map(), relative = '') {
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (ignored.some(pattern => rel.toLowerCase().includes(pattern.toLowerCase()))) continue;
    const full = path.join(root, rel);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      result.set(rel, { relative: rel, directory: true });
      await scanFolder(root, ignored, result, rel);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full);
      result.set(rel, { relative: rel, directory: false, size: stat.size, modified: stat.mtimeMs, path: full });
    }
  }
  return result;
}
async function compareFolders() {
  const ignored = request.options.exclusions || ['node_modules', '.git'];
  report(10, 'Scanning left folder');
  const left = await scanFolder(request.left.path, ignored);
  report(40, 'Scanning right folder');
  const right = await scanFolder(request.right.path, ignored);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const entries = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i], a = left.get(name), b = right.get(name);
    let status = a && b ? 'same' : a ? 'removed' : 'added';
    if (a && b && (a.directory !== b.directory || (!a.directory && (a.size !== b.size || await hash(a.path) !== await hash(b.path))))) status = 'modified';
    entries.push({ relative: name, left: a, right: b, status, directory: !!(a?.directory || b?.directory) });
    if (i % 30 === 0) report(40 + Math.floor(55 * i / Math.max(names.length, 1)), 'Comparing folders');
  }
  return { entries, count: entries.filter(item => item.status !== 'same').length };
}
async function ocr(buffer) {
  const { createWorker } = require('tesseract.js');
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int');
  const worker = await createWorker('eng', undefined, { langPath, cacheMethod: 'none' });
  try { return (await worker.recognize(buffer)).data.text; }
  finally { await worker.terminate(); }
}
async function renderPdfPage(input, requestedPage = request.options.page) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const loading = pdfjs.getDocument({ data: new Uint8Array(await fsp.readFile(input.path)), password: request.options.password || undefined, useSystemFonts: true });
  const pdf = await loading.promise;
  const pageNumber = Math.max(1, Math.min(Number(requestedPage) || 1, pdf.numPages));
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
  return canvas.toBuffer('image/png');
}
async function compareImages() {
  report(10, 'Decoding images');
  const image = async input => {
    if (path.extname(input.path).toLowerCase() === '.pdf') return renderPdfPage(input);
    return sharp(input.path, { page: request.options.page || 0 }).ensureAlpha().png().toBuffer();
  };
  const [left, right] = await Promise.all([image(request.left), image(request.right)]);
  const [lm, rm] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()]);
  const width = Math.max(lm.width, rm.width), height = Math.max(lm.height, rm.height);
  const raw = async bytes => sharp(bytes).extend({ right: width - (await sharp(bytes).metadata()).width, bottom: height - (await sharp(bytes).metadata()).height, background: '#00000000' }).raw().toBuffer();
  const [a, b] = await Promise.all([raw(left), raw(right)]);
  const diff = Buffer.alloc(width * height * 4);
  const mask = new Uint8Array(width * height);
  const threshold = request.options.threshold ?? 24;
  let changed = 0, minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const delta = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2]), Math.abs(a[i+3]-b[i+3]));
      if (delta > threshold) {
        diff[i] = 240; diff[i+1] = 75; diff[i+2] = 75; diff[i+3] = 255;
        mask[y * width + x] = 1;
        changed++; minX = Math.min(minX,x); minY = Math.min(minY,y); maxX = Math.max(maxX,x); maxY = Math.max(maxY,y);
      } else { diff[i+3] = 0; }
    }
  }
  report(80, 'Reading image details');
  const [leftExif, rightExif] = await Promise.all([exifr.parse(request.left.path).catch(() => ({})), exifr.parse(request.right.path).catch(() => ({}))]);
  const diffPng = await sharp(diff, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const regions = [];
  const minimum = Math.max(1, Number(request.options.minRegionSize) || 1);
  for (let position = 0; position < mask.length; position++) {
    if (mask[position] !== 1) continue;
    const pending = [position];
    mask[position] = 2;
    let area = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
    while (pending.length) {
      const current = pending.pop();
      const x = current % width, y = Math.floor(current / width);
      area++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (const neighbor of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
        if (neighbor >= 0 && mask[neighbor] === 1) { mask[neighbor] = 2; pending.push(neighbor); }
      }
    }
    if (area >= minimum) regions.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: area });
  }
  regions.sort((a, b) => b.pixels - a.pixels);
  let leftOcr, rightOcr;
  if (request.options.ocr) { report(85, 'Reading text in images'); [leftOcr, rightOcr] = await Promise.all([ocr(left), ocr(right)]); }
  return {
    leftData: 'data:image/png;base64,' + left.toString('base64'), rightData: 'data:image/png;base64,' + right.toString('base64'),
    diffData: 'data:image/png;base64,' + diffPng.toString('base64'),
    width, height, changed, count: regions.length,
    bounds: changed ? { x: minX, y: minY, width: maxX-minX+1, height: maxY-minY+1 } : null,
    regions,
    leftExif, rightExif, leftOcr, rightOcr
  };
}
async function documentText(input) {
  const ext = path.extname(input.path).toLowerCase();
  if (ext === '.docx') return (await mammoth.extractRawText({ path: input.path })).value;
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = pdfjs.getDocument({ data: new Uint8Array(await fsp.readFile(input.path)), password: request.options.password || undefined, useSystemFonts: true });
    const pdf = await loading.promise;
    const pages = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      let text = content.items.map(item => item.str).join(' ');
      if (request.options.ocr && !text.trim()) {
        report(Math.min(70, 12 + Math.round(50 * page / pdf.numPages)), `Reading scanned page ${page}`);
        text = await ocr(await renderPdfPage(input, page));
      }
      pages.push(text);
    }
    return pages.join('\n\n');
  }
  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(await fsp.readFile(input.path));
    const parser = new XMLParser({ ignoreAttributes: false });
    const names = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b) => Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
    const slides = [];
    for (const name of names) {
      const xml = parser.parse(await zip.files[name].async('string'));
      const values = [];
      const visit = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (key === 'a:t') values.push(String(child)); else if (Array.isArray(child)) child.forEach(visit); else visit(child); } };
      visit(xml); slides.push(values.join(' '));
    }
    return slides.join('\n\n');
  }
  throw new Error('Unsupported document type.');
}
async function compareDocuments() {
  report(10, 'Extracting documents');
  const [left, right] = await Promise.all([documentText(request.left), documentText(request.right)]);
  report(75, 'Finding document changes');
  return { ...textDiff(left, right, request.options), leftName: request.left.name, rightName: request.right.name };
}
async function run() {
  if (!request.left || !request.right) throw new Error('Choose two inputs to compare.');
  const operation = { text: compareText, images: compareImages, documents: compareDocuments, excel: compareExcel, folders: compareFolders }[request.type];
  if (!operation) throw new Error('Unknown comparison type.');
  const result = await operation();
  report(100, 'Complete');
  parentPort.postMessage({ kind: 'result', result });
}
run().catch(error => parentPort.postMessage({ kind: 'error', error: error.message || String(error) }));
