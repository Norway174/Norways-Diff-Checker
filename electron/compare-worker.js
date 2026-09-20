const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const Diff = require('diff');
const XLSX = require('xlsx');
const sharp = require('sharp');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const exifr = require('exifr');

const report = (value, phase) => parentPort.postMessage({ kind: 'progress', value, phase });
const request = workerData;
const activeChildren = new Set();
let cancelled = false;
parentPort.on('message', message => { if (message?.kind === 'cancel') { cancelled = true; for (const child of activeChildren) child.kill(); } });
async function officePdf(input) {
  if (path.extname(input.path).toLowerCase() === '.pdf') return { file: input.path, clean: async () => {} };
  const packagedEngine = process.resourcesPath && path.join(process.resourcesPath, 'libreoffice', 'program', 'soffice.exe');
  const engine = packagedEngine && fs.existsSync(packagedEngine) ? packagedEngine
    : path.join(__dirname, '..', 'vendor', 'libreoffice-msi', 'program', 'soffice.exe');
  if (!fs.existsSync(engine)) throw new Error('Bundled LibreOffice engine is missing. Rebuild the app assets.');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ndc-office-'));
  const output = path.join(work, path.parse(input.path).name + '.pdf');
  const profile = pathToFileURL(path.join(work, 'profile')).href;
  const clean = async () => {
    if (!path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe Office cleanup path.');
    await fsp.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(engine, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', work, input.path], { windowsHide: true });
      activeChildren.add(child);
      const timer = setTimeout(() => { child.kill(); reject(new Error('Office conversion timed out.')); }, 120000);
      child.on('error', error => { activeChildren.delete(child); clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); activeChildren.delete(child); if (cancelled) reject(new Error('Comparison cancelled.')); else if (code === 0) resolve(); else reject(new Error(`Office conversion failed (${code}).`)); });
    });
    if (!fs.existsSync(output)) throw new Error('Office conversion produced no PDF.');
    return { file: output, clean };
  } catch (error) { await clean(); throw error; }
}
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
  const columnPositions = [];
  if (request.options.alignColumns !== false) {
    const header = rows => Array.from({ length: rows.reduce((maximum, row) => Math.max(maximum, row.length), 0) }, (_, col) => cellValue(rows[0]?.[col] || { display: '', formula: '' }, request.options));
    const leftHeaders = header(leftRows), rightHeaders = header(rightRows);
    const parts = Diff.diffArrays(leftHeaders, rightHeaders);
    let l = 0, r = 0;
    for (let index = 0; index < parts.length;) {
      if (!parts[index].added && !parts[index].removed) {
        for (let count = 0; count < parts[index].value.length; count++) columnPositions.push({ left: l++, right: r++ });
        index++;
      } else {
        let removed = 0, added = 0;
        while (index < parts.length && (parts[index].added || parts[index].removed)) {
          if (parts[index].removed) removed += parts[index].value.length;
          if (parts[index].added) added += parts[index].value.length;
          index++;
        }
        for (let count = 0; count < Math.max(removed, added); count++) columnPositions.push({ left: count < removed ? l++ : null, right: count < added ? r++ : null });
      }
    }
    leftRows = leftRows.map(row => columnPositions.map(position => position.left === null ? undefined : row[position.left]));
    rightRows = rightRows.map(row => columnPositions.map(position => position.right === null ? undefined : row[position.right]));
  } else {
    const maximum = Math.max(leftRows.reduce((value, row) => Math.max(value, row.length), 0), rightRows.reduce((value, row) => Math.max(value, row.length), 0));
    for (let col = 0; col < maximum; col++) columnPositions.push({ left: col, right: col });
  }
  let leftSourceRows = leftRows.map((_, index) => index + 1);
  let rightSourceRows = rightRows.map((_, index) => index + 1);
  if (request.options.sortColumn) {
    let column;
    try { column = XLSX.utils.decode_col(String(request.options.sortColumn).toUpperCase()); }
    catch { throw new Error('Sort column must be an Excel column letter, such as A or C.'); }
    const sort = (rows, sources) => {
      const paired = rows.map((row, index) => ({ row, source: sources[index] }));
      const header = paired.shift();
      paired.sort((a, b) => String(a.row[column]?.display ?? '').localeCompare(String(b.row[column]?.display ?? ''), undefined, { numeric: true }));
      const sorted = header ? [header, ...paired] : paired;
      return { rows: sorted.map(item => item.row), sources: sorted.map(item => item.source) };
    };
    const sortedLeft = sort(leftRows, leftSourceRows), sortedRight = sort(rightRows, rightSourceRows);
    leftRows = sortedLeft.rows; leftSourceRows = sortedLeft.sources;
    rightRows = sortedRight.rows; rightSourceRows = sortedRight.sources;
  }
  const rowPositions = [];
  if (request.options.alignRows !== false) {
    const sharedColumn = columnPositions.findIndex(position => position.left !== null && position.right !== null);
    const key = row => cellValue(row[sharedColumn] || { display: '', formula: '' }, request.options) || row.map(cell => cellValue(cell || { display: '', formula: '' }, request.options)).join('\u0001');
    const parts = Diff.diffArrays(leftRows.map(key), rightRows.map(key));
    const pairedLeft = [], pairedRight = [];
    let l = 0, r = 0;
    for (let index = 0; index < parts.length;) {
      if (!parts[index].added && !parts[index].removed) {
        for (let count = 0; count < parts[index].value.length; count++) {
          pairedLeft.push(leftRows[l]); pairedRight.push(rightRows[r]); rowPositions.push({ left: leftSourceRows[l++], right: rightSourceRows[r++] });
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
          const leftIndex = count < removed ? l++ : null, rightIndex = count < added ? r++ : null;
          pairedLeft.push(leftIndex === null ? [] : leftRows[leftIndex]);
          pairedRight.push(rightIndex === null ? [] : rightRows[rightIndex]);
          rowPositions.push({ left: leftIndex === null ? null : leftSourceRows[leftIndex], right: rightIndex === null ? null : rightSourceRows[rightIndex] });
        }
      }
    }
    leftRows = pairedLeft; rightRows = pairedRight;
  } else {
    for (let row = 0; row < Math.max(leftRows.length, rightRows.length); row++) {
      rowPositions.push({ left: leftSourceRows[row] ?? null, right: rightSourceRows[row] ?? null });
    }
  }
  report(70, 'Finding cell changes');
  const changed = [];
  for (let row = 0; row < Math.max(leftRows.length, rightRows.length); row++) {
    for (let col = 0; col < Math.max(leftRows[row]?.length || 0, rightRows[row]?.length || 0); col++) {
      const a = leftRows[row]?.[col], b = rightRows[row]?.[col];
      if (cellValue(a || { display: '', formula: '' }, request.options) !== cellValue(b || { display: '', formula: '' }, request.options)) changed.push({ row, col, left: a?.display ?? '', right: b?.display ?? '', leftFormula: a?.formula ?? '', rightFormula: b?.formula ?? '', leftRow: rowPositions[row]?.left ?? null, rightRow: rowPositions[row]?.right ?? null, leftColumn: columnPositions[col]?.left ?? null, rightColumn: columnPositions[col]?.right ?? null });
    }
  }
  return { leftSheets: left.SheetNames, rightSheets: right.SheetNames, leftName, rightName, leftRows, rightRows, rowPositions, columnPositions, changed, count: changed.length,
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
function excluded(relative, patterns) {
  const normalized = relative.replace(/\\/g, '/').toLowerCase();
  return patterns.some(pattern => {
    const value = String(pattern).trim().replace(/\\/g, '/').toLowerCase().replace(/^\/+|\/+$/g, '');
    if (!value) return false;
    if (!/[?*]/.test(value)) return value.includes('/') ? normalized === value || normalized.startsWith(value + '/') : normalized.split('/').includes(value);
    const escaped = value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    const expression = new RegExp('^' + (value.includes('/') ? '' : '(?:.*/)?') + escaped + '(?:/.*)?$');
    return expression.test(normalized);
  });
}
async function scanFolder(root, ignored, result = new Map(), relative = '') {
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (excluded(rel, ignored)) continue;
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
  if (!fs.existsSync(request.left.path)) throw new Error('Original folder is missing: ' + request.left.path);
  if (!fs.existsSync(request.right.path)) throw new Error('Changed folder is missing: ' + request.right.path);
  report(10, 'Scanning left folder');
  const left = await scanFolder(request.left.path, ignored);
  report(40, 'Scanning right folder');
  const right = await scanFolder(request.right.path, ignored);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const entries = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i], a = left.get(name), b = right.get(name);
    let status = a && b ? 'same' : a ? 'removed' : 'added';
    let metadataChanged = false;
    if (a && b) {
      if (a.directory !== b.directory) status = 'modified';
      else if (!a.directory) {
        const [leftHash, rightHash] = await Promise.all([hash(a.path), hash(b.path)]);
        a.hash = leftHash; b.hash = rightHash;
        metadataChanged = a.size !== b.size || Math.abs(a.modified - b.modified) > 2000;
        if (leftHash !== rightHash || (request.options.compareMetadata && metadataChanged)) status = 'modified';
      }
    }
    entries.push({ relative: name, left: a, right: b, status, metadataChanged, directory: !!(a?.directory || b?.directory) });
    if (i % 30 === 0) report(40 + Math.floor(55 * i / Math.max(names.length, 1)), 'Comparing folders');
  }
  return { entries, count: entries.filter(item => item.status !== 'same').length };
}
async function ocrDetailed(buffer, positioned = false) {
  const { createWorker } = require('tesseract.js');
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int');
  const worker = await createWorker('eng', undefined, { langPath, cacheMethod: 'none' });
  try {
    const data = (await worker.recognize(buffer, {}, { text: true, blocks: positioned })).data;
    const words = positioned ? (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => (paragraph.lines || []).flatMap(line => (line.words || []).map(word => ({ text: word.text, ...word.bbox, confidence: word.confidence }))))) : [];
    return { text: data.text, words };
  }
  finally { await worker.terminate(); }
}
async function ocr(buffer) { return (await ocrDetailed(buffer)).text; }
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
async function estimateImageShift(left, right, leftSize, rightSize) {
  const sample = async bytes => sharp(bytes).greyscale().resize(128, 128, { fit: 'fill' }).raw().toBuffer();
  const [a, b] = await Promise.all([sample(left), sample(right)]);
  let best = { score: Infinity, dx: 0, dy: 0 };
  for (let dy = -12; dy <= 12; dy += 2) for (let dx = -12; dx <= 12; dx += 2) {
    let error = 0, samples = 0;
    for (let y = 12; y < 116; y += 3) for (let x = 12; x < 116; x += 3) {
      const rx = x - dx, ry = y - dy;
      if (rx < 0 || rx >= 128 || ry < 0 || ry >= 128) continue;
      error += Math.abs(a[y * 128 + x] - b[ry * 128 + rx]); samples++;
    }
    const score = error / Math.max(1, samples) + (Math.abs(dx) + Math.abs(dy)) * 0.06;
    if (score < best.score) best = { score, dx, dy };
  }
  return { x: Math.round(best.dx * Math.max(leftSize.width, rightSize.width) / 128), y: Math.round(best.dy * Math.max(leftSize.height, rightSize.height) / 128) };
}
async function perspectiveWarp(bytes, horizontal, vertical) {
  if (!horizontal && !vertical) return bytes;
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width * height > 30000000) throw new Error('Perspective adjustment supports images up to 30 million pixels.');
  const hx = Math.max(-45, Math.min(45, horizontal)) * width / 100;
  const vy = Math.max(-45, Math.min(45, vertical)) * height / 100;
  const target = [[hx, vy], [width - 1 - hx, 0], [0, height - 1 - vy], [width - 1, height - 1]];
  const source = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  const equations = target.map(([x, y], index) => {
    const [u, v] = source[index];
    return [[x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]];
  }).flat();
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(equations[row][col]) > Math.abs(equations[pivot][col])) pivot = row;
    if (Math.abs(equations[pivot][col]) < 1e-9) throw new Error('Perspective adjustment is too extreme for this image.');
    [equations[col], equations[pivot]] = [equations[pivot], equations[col]];
    const divisor = equations[col][col];
    for (let entry = col; entry < 9; entry++) equations[col][entry] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== col) {
      const factor = equations[row][col];
      for (let entry = col; entry < 9; entry++) equations[row][entry] -= factor * equations[col][entry];
    }
  }
  const h = equations.map(row => row[8]);
  const warped = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (cancelled) throw new Error('Comparison cancelled.');
    for (let x = 0; x < width; x++) {
      const divisor = h[6] * x + h[7] * y + 1;
      const sx = (h[0] * x + h[1] * y + h[2]) / divisor;
      const sy = (h[3] * x + h[4] * y + h[5]) / divisor;
      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const top = (y0 * width + x0) * 4, bottom = top + width * 4, out = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) warped[out + channel] = Math.round(
        data[top + channel] * (1 - fx) * (1 - fy) + data[top + 4 + channel] * fx * (1 - fy) +
        data[bottom + channel] * (1 - fx) * fy + data[bottom + 4 + channel] * fx * fy
      );
    }
  }
  return sharp(warped, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
async function compareImages() {
  report(10, 'Decoding images');
  const image = async input => {
    if (path.extname(input.path).toLowerCase() === '.pdf') return renderPdfPage(input);
    if (path.extname(input.path).toLowerCase() === '.heic') return Buffer.from(await require('heic-convert')({ buffer: await fsp.readFile(input.path), format: 'PNG' }));
    return sharp(input.path, { page: request.options.page || 0 }).ensureAlpha().png().toBuffer();
  };
  const [sourceLeft, sourceRight] = await Promise.all([image(request.left), image(request.right)]);
  let transformed = sharp(sourceRight).ensureAlpha();
  if (request.options.flipX) transformed = transformed.flop();
  if (request.options.flipY) transformed = transformed.flip();
  const scale = Math.min(4, Math.max(0.1, (Number(request.options.scale) || 100) / 100));
  if (scale !== 1) {
    const sourceSize = await sharp(sourceRight).metadata();
    transformed = transformed.resize(Math.max(1, Math.round(sourceSize.width * scale)), Math.max(1, Math.round(sourceSize.height * scale)));
  }
  if (Number(request.options.rotation)) transformed = transformed.rotate(Number(request.options.rotation), { background: '#00000000' });
  const rightImage = await perspectiveWarp(await transformed.png().toBuffer(), Number(request.options.perspectiveX) || 0, Number(request.options.perspectiveY) || 0);
  const [lm, rm] = await Promise.all([sharp(sourceLeft).metadata(), sharp(rightImage).metadata()]);
  const automatic = request.options.autoAlign ? await estimateImageShift(sourceLeft, rightImage, lm, rm) : { x: 0, y: 0 };
  const offsetX = Math.round(Number(request.options.offsetX) || 0) + automatic.x;
  const offsetY = Math.round(Number(request.options.offsetY) || 0) + automatic.y;
  const leftX = Math.max(0, -offsetX), leftY = Math.max(0, -offsetY);
  const rightX = leftX + offsetX, rightY = leftY + offsetY;
  const width = Math.max(leftX + lm.width, rightX + rm.width), height = Math.max(leftY + lm.height, rightY + rm.height);
  const canvas = (bytes, x, y) => sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite([{ input: bytes, left: x, top: y }]).png().toBuffer();
  const [left, right] = await Promise.all([canvas(sourceLeft, leftX, leftY), canvas(rightImage, rightX, rightY)]);
  const [a, b] = await Promise.all([sharp(left).ensureAlpha().raw().toBuffer(), sharp(right).ensureAlpha().raw().toBuffer()]);
  const diff = Buffer.alloc(width * height * 4);
  const subtract = Buffer.alloc(width * height * 4);
  const mask = new Uint8Array(width * height);
  const threshold = request.options.threshold ?? 24;
  let changed = 0, minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const delta = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2]), Math.abs(a[i+3]-b[i+3]));
      subtract[i] = Math.abs(a[i] - b[i]); subtract[i+1] = Math.abs(a[i+1] - b[i+1]); subtract[i+2] = Math.abs(a[i+2] - b[i+2]); subtract[i+3] = 255;
      if (delta > threshold) {
        diff[i] = 240; diff[i+1] = 75; diff[i+2] = 75; diff[i+3] = 255;
        mask[y * width + x] = 1;
        changed++; minX = Math.min(minX,x); minY = Math.min(minY,y); maxX = Math.max(maxX,x); maxY = Math.max(maxY,y);
      } else { diff[i+3] = 0; }
    }
  }
  report(80, 'Reading image details');
  const [leftExif, rightExif, leftStat, rightStat] = await Promise.all([
    exifr.parse(request.left.path).catch(() => ({})), exifr.parse(request.right.path).catch(() => ({})),
    fsp.stat(request.left.path), fsp.stat(request.right.path)
  ]);
  const diffPng = await sharp(diff, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const subtractPng = await sharp(subtract, { raw: { width, height, channels: 4 } }).png().toBuffer();
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
  const gap = Math.min(100, Math.max(0, Number(request.options.regionGap) || 0));
  if (gap && regions.length <= 10000) {
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length;) {
        const a = regions[i], b = regions[j];
        const near = a.x <= b.x + b.width + gap && b.x <= a.x + a.width + gap && a.y <= b.y + b.height + gap && b.y <= a.y + a.height + gap;
        if (near) {
          const right = Math.max(a.x + a.width, b.x + b.width), bottom = Math.max(a.y + a.height, b.y + b.height);
          a.x = Math.min(a.x, b.x); a.y = Math.min(a.y, b.y); a.width = right - a.x; a.height = bottom - a.y; a.pixels += b.pixels;
          regions.splice(j, 1); i = -1; break;
        } else j++;
      }
    }
    regions.sort((a, b) => b.pixels - a.pixels);
  }
  for (const region of regions.slice(0, 30)) {
    const area = { left: region.x, top: region.y, width: region.width, height: region.height };
    const [original, changedPreview] = await Promise.all([
      sharp(left).extract(area).resize(96, 64, { fit: 'inside', withoutEnlargement: true }).png().toBuffer(),
      sharp(right).extract(area).resize(96, 64, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    ]);
    region.previewLeft = 'data:image/png;base64,' + original.toString('base64');
    region.previewRight = 'data:image/png;base64,' + changedPreview.toString('base64');
  }
  let leftOcr, rightOcr, leftOcrWords, rightOcrWords;
  if (request.options.ocr) {
    report(85, 'Reading text in images');
    const [leftRead, rightRead] = await Promise.all([ocrDetailed(left, true), ocrDetailed(right, true)]);
    leftOcr = leftRead.text; rightOcr = rightRead.text;
    leftOcrWords = leftRead.words; rightOcrWords = rightRead.words;
  }
  return {
    leftData: 'data:image/png;base64,' + left.toString('base64'), rightData: 'data:image/png;base64,' + right.toString('base64'),
    diffData: 'data:image/png;base64,' + diffPng.toString('base64'),
    subtractData: 'data:image/png;base64,' + subtractPng.toString('base64'),
    width, height, changed, count: regions.length,
    alignment: { offsetX, offsetY, automatic },
    bounds: changed ? { x: minX, y: minY, width: maxX-minX+1, height: maxY-minY+1 } : null,
    regions,
    leftExif, rightExif, leftOcr, rightOcr, leftOcrWords, rightOcrWords,
    leftDetails: { width: lm.width, height: lm.height, bytes: leftStat.size, modified: leftStat.mtime.toISOString(), exif: leftExif },
    rightDetails: { width: rm.width, height: rm.height, bytes: rightStat.size, modified: rightStat.mtime.toISOString(), exif: rightExif }
  };
}
function orderedPages(count, selected) {
  const unique = Array.isArray(selected) ? [...new Set(selected.map(Number).filter(number => Number.isInteger(number) && number >= 1 && number <= count))] : [];
  return [...unique, ...Array.from({ length: count }, (_, index) => index + 1).filter(number => !unique.includes(number))];
}
async function embeddedImageText(input, prefix) {
  if (!request.options.ocr) return '';
  const zip = await JSZip.loadAsync(await fsp.readFile(input.path));
  const names = Object.keys(zip.files).filter(name => name.startsWith(prefix) && /\.(png|jpe?g|webp|gif|tiff?)$/i.test(name)).sort();
  const found = [];
  for (let index = 0; index < names.length; index++) {
    if (cancelled) throw new Error('Comparison cancelled.');
    report(Math.min(70, 15 + Math.round(45 * (index + 1) / Math.max(names.length, 1))), `Reading embedded image ${index + 1}`);
    const text = (await ocr(await zip.files[names[index]].async('nodebuffer'))).trim();
    if (text) found.push(`[Embedded image ${index + 1}: ${path.basename(names[index])}]\n${text}`);
  }
  return found.join('\n\n');
}
async function documentText(input, side) {
  const ext = path.extname(input.path).toLowerCase();
  if (ext === '.docx') {
    const body = (await mammoth.extractRawText({ path: input.path })).value;
    const images = await embeddedImageText(input, 'word/media/');
    return images ? body + '\n\n' + images : body;
  }
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
    return (side === 'right' ? orderedPages(pages.length, request.options.rightPageOrder).map(number => pages[number - 1]) : pages).join('\n\n');
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
    const images = await embeddedImageText(input, 'ppt/media/');
    return slides.join('\n\n') + (images ? '\n\n' + images : '');
  }
  throw new Error('Unsupported document type.');
}
async function documentStructure(input) {
  const ext = path.extname(input.path).toLowerCase();
  if (ext === '.docx') {
    const zip = await JSZip.loadAsync(await fsp.readFile(input.path));
    const xml = zip.file('word/document.xml');
    if (!xml) throw new Error('DOCX document.xml is missing.');
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await xml.async('string'));
    const paragraphs = [];
    const collectText = value => {
      if (value == null) return '';
      if (typeof value !== 'object') return String(value);
      if (Array.isArray(value)) return value.map(collectText).join('');
      return Object.entries(value).filter(([key]) => key === 'w:t' || key === '#text').map(([, child]) => collectText(child)).join('');
    };
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'w:p') {
          for (const para of Array.isArray(child) ? child : [child]) {
            const runs = (Array.isArray(para['w:r']) ? para['w:r'] : para['w:r'] ? [para['w:r']] : []).map(run => ({
              text: collectText(run['w:t']), bold: Object.hasOwn(run['w:rPr'] || {}, 'w:b'), italic: Object.hasOwn(run['w:rPr'] || {}, 'w:i'),
              color: run['w:rPr']?.['w:color']?.['@_w:val'] || null,
              font: run['w:rPr']?.['w:rFonts']?.['@_w:ascii'] || null,
              size: run['w:rPr']?.['w:sz']?.['@_w:val'] || null
            }));
            const text = runs.map(run => run.text).join('');
            paragraphs.push({ text, style: para['w:pPr']?.['w:pStyle']?.['@_w:val'] || null, runs });
            for (const [nestedKey, nested] of Object.entries(para)) if (nestedKey !== 'w:r') visit(nested);
          }
        } else if (key !== 'w:r') visit(child);
      }
    };
    visit(parsed['w:document']?.['w:body']);
    const imageNames = Object.keys(zip.files).filter(name => /^word\/media\/[^/]+$/.test(name)).sort();
    const images = await Promise.all(imageNames.map(async name => ({ name: path.basename(name), hash: crypto.createHash('sha256').update(await zip.files[name].async('nodebuffer')).digest('hex') })));
    return { kind: 'docx', paragraphs, images, pageCount: null };
  }
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await fsp.readFile(input.path)), password: request.options.password || undefined, useSystemFonts: true }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
      pages.push({ number, width: Math.round(size.width), height: Math.round(size.height), textHash: crypto.createHash('sha256').update(text).digest('hex') });
    }
    return { kind: 'pdf', paragraphs: [], images: [], pageCount: pdf.numPages, pages };
  }
  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(await fsp.readFile(input.path));
    const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const imageNames = Object.keys(zip.files).filter(name => /^ppt\/media\/[^/]+$/.test(name)).sort();
    const images = await Promise.all(imageNames.map(async name => ({ name: path.basename(name), hash: crypto.createHash('sha256').update(await zip.files[name].async('nodebuffer')).digest('hex') })));
    return { kind: 'pptx', paragraphs: [], images, pageCount: slides.length };
  }
  return { kind: ext.slice(1), paragraphs: [], images: [], pageCount: null };
}
async function compareDocuments() {
  report(10, 'Extracting documents');
  const [left, right, leftStructure, rightStructure] = await Promise.all([
    documentText(request.left, 'left'), documentText(request.right, 'right'), documentStructure(request.left), documentStructure(request.right)
  ]);
  report(75, 'Finding document changes');
  const structuralChanges = [];
  if (leftStructure.pageCount !== rightStructure.pageCount) structuralChanges.push({ kind: 'pages', reference: 'Document', left: leftStructure.pageCount, right: rightStructure.pageCount });
  if (leftStructure.images.length !== rightStructure.images.length) structuralChanges.push({ kind: 'images', reference: 'Document', left: leftStructure.images.length, right: rightStructure.images.length });
  for (let index = 0; index < Math.min(leftStructure.images.length, rightStructure.images.length); index++) {
    if (leftStructure.images[index].hash !== rightStructure.images[index].hash) structuralChanges.push({ kind: 'image', reference: `Image ${index + 1}`, left: leftStructure.images[index].name, right: rightStructure.images[index].name });
  }
  if (leftStructure.pages && rightStructure.pages) {
    const rightPages = new Map(rightStructure.pages.map((page, index) => [page.textHash, index]));
    for (let index = 0; index < Math.min(leftStructure.pages.length, rightStructure.pages.length); index++) {
      const a = leftStructure.pages[index], b = rightStructure.pages[index];
      if (a.width !== b.width || a.height !== b.height) structuralChanges.push({ kind: 'layout', reference: `Page ${index + 1}`, left: `${a.width} × ${a.height}`, right: `${b.width} × ${b.height}` });
      const destination = rightPages.get(a.textHash);
      if (destination !== undefined && destination !== index && a.textHash !== b.textHash) structuralChanges.push({ kind: 'moved page', reference: `Page ${index + 1} → ${destination + 1}` });
    }
  }
  const leftParagraphs = leftStructure.paragraphs, rightParagraphs = rightStructure.paragraphs;
  for (let index = 0; index < Math.min(leftParagraphs.length, rightParagraphs.length); index++) {
    const a = leftParagraphs[index], b = rightParagraphs[index];
    if (a.text && a.text === b.text && JSON.stringify({ style: a.style, runs: a.runs }) !== JSON.stringify({ style: b.style, runs: b.runs }))
      structuralChanges.push({ kind: 'formatting', reference: `Paragraph ${index + 1}`, left: a, right: b });
  }
  const rightLocations = new Map(rightParagraphs.map((paragraph, index) => [paragraph.text, index]));
  for (let index = 0; index < leftParagraphs.length; index++) {
    const text = leftParagraphs[index].text;
    const destination = rightLocations.get(text);
    if (text && destination !== undefined && destination !== index && !rightParagraphs[index]?.text?.includes(text))
      structuralChanges.push({ kind: 'moved', reference: `Paragraph ${index + 1} → ${destination + 1}`, text });
  }
  let pageImages = null;
  if (request.options.view === 'image') {
    report(82, 'Rendering document pages');
    const conversions = await Promise.allSettled([officePdf(request.left), officePdf(request.right)]);
    if (conversions.some(result => result.status === 'rejected')) {
      await Promise.all(conversions.filter(result => result.status === 'fulfilled').map(result => result.value.clean()));
      throw conversions.find(result => result.status === 'rejected').reason;
    }
    const [leftOffice, rightOffice] = conversions.map(result => result.value);
    try {
      const rightPage = path.extname(request.right.path).toLowerCase() === '.pdf'
        ? orderedPages(rightStructure.pageCount, request.options.rightPageOrder)[Math.max(0, (Number(request.options.page) || 1) - 1)] || 1
        : request.options.page;
      const [leftPage, rightPageBytes] = await Promise.all([renderPdfPage({ path: leftOffice.file }), renderPdfPage({ path: rightOffice.file }, rightPage)]);
      pageImages = { left: 'data:image/png;base64,' + leftPage.toString('base64'), right: 'data:image/png;base64,' + rightPageBytes.toString('base64') };
    } finally { await Promise.all([leftOffice.clean(), rightOffice.clean()]); }
  }
  return { ...textDiff(left, right, request.options), leftName: request.left.name, rightName: request.right.name,
    leftStructure, rightStructure, structuralChanges, pageImages };
}
async function run() {
  if (!request.left || !request.right) throw new Error('Choose two inputs to compare.');
  const operation = { text: compareText, images: compareImages, documents: compareDocuments, excel: compareExcel, folders: compareFolders }[request.type];
  if (!operation) throw new Error('Unknown comparison type.');
  const result = await operation();
  report(100, 'Complete');
  parentPort.postMessage({ kind: 'result', result });
}
run().catch(error => parentPort.postMessage({ kind: 'error', error: error.message || String(error) })).finally(() => parentPort.close());
