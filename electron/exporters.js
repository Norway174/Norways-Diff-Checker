const { Document, Packer, Paragraph } = require('docx');
const JSZip = require('jszip');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const Diff = require('diff');
const fsp = require('node:fs/promises');
const path = require('node:path');

function textFromComparison({ leftText = '', rightText = '', leftName = 'Original', rightName = 'Changed', kind = 'changed', fenced = false }) {
  let text;
  if (kind === 'original') text = String(leftText);
  else if (kind === 'changed') text = String(rightText);
  else if (kind === 'unified') text = Diff.createTwoFilesPatch(leftName || 'Original', rightName || 'Changed', String(leftText), String(rightText), '', '', { context: 3 });
  else throw new Error('Unsupported text export type.');
  if (!fenced) return text;
  return `\`\`\`diff\n${text}${text.endsWith('\n') ? '' : '\n'}\`\`\``;
}

async function imageBuffer(dataUrl, assetRoot) {
  const value = String(dataUrl || '');
  const match = /^data:image\/png;base64,(.+)$/s.exec(value);
  if (match) return Buffer.from(match[1], 'base64');
  const url = new URL(value);
  if (url.protocol !== 'ndc-asset:' || !assetRoot || !/^[0-9a-f-]{36}$/i.test(url.hostname)) throw new Error('The image comparison is missing rendered PNG data.');
  const name = path.basename(decodeURIComponent(url.pathname));
  if (!/^[a-z0-9-]+\.png$/i.test(name)) throw new Error('The image comparison asset is invalid.');
  return fsp.readFile(path.join(assetRoot, url.hostname, name));
}

async function rawImage(dataUrl, assetRoot) {
  return sharp(await imageBuffer(dataUrl, assetRoot)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function pngFromRaw(data, info) {
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function imageViewFromComparison({ result, options, flickerRight = false, assetRoot }) {
  const view = options.view || 'split';
  if (view === 'split') {
    const [left, right] = await Promise.all([imageBuffer(result.splitLeftData || result.leftData, assetRoot), imageBuffer(result.splitRightData || result.rightData, assetRoot)]);
    const [leftInfo, rightInfo] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()]);
    const horizontal = options.splitOrientation === 'horizontal';
    const width = horizontal ? Math.max(leftInfo.width, rightInfo.width) : leftInfo.width + rightInfo.width;
    const height = horizontal ? leftInfo.height + rightInfo.height : Math.max(leftInfo.height, rightInfo.height);
    return sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite([
      { input: left, left: horizontal ? Math.floor((width - leftInfo.width) / 2) : 0, top: horizontal ? 0 : Math.floor((height - leftInfo.height) / 2) },
      { input: right, left: horizontal ? Math.floor((width - rightInfo.width) / 2) : leftInfo.width, top: horizontal ? leftInfo.height : Math.floor((height - rightInfo.height) / 2) }
    ]).png().toBuffer();
  }
  if (view === 'subtract') return imageBuffer(result.subtractData, assetRoot);
  if (view === 'flicker') return imageBuffer(flickerRight ? result.rightData : result.leftData, assetRoot);
  if (!['slider', 'fade', 'highlight'].includes(view)) throw new Error('Image View export is only available for visual image views.');

  const [left, right] = await Promise.all([rawImage(result.leftData, assetRoot), rawImage(view === 'highlight' ? result.diffData : result.rightData, assetRoot)]);
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) throw new Error('The rendered image layers have different dimensions.');
  const output = Buffer.from(left.data);
  if (view === 'slider') {
    const split = Math.max(0, Math.min(left.info.width, Math.round(left.info.width * Number(options.opacity || 0) / 101)));
    for (let y = 0; y < left.info.height; y++) for (let x = 0; x < split; x++) {
      const index = (y * left.info.width + x) * 4;
      if (options.sliderNoOverlap) right.data.copy(output, index, index, index + 4);
      else {
        const overlayAlpha = right.data[index + 3] / 255;
        const baseAlpha = left.data[index + 3] / 255;
        const alpha = overlayAlpha + baseAlpha * (1 - overlayAlpha);
        if (!alpha) output.fill(0, index, index + 4);
        else {
          for (let channel = 0; channel < 3; channel++) output[index + channel] = Math.round((right.data[index + channel] * overlayAlpha + left.data[index + channel] * baseAlpha * (1 - overlayAlpha)) / alpha);
          output[index + 3] = Math.round(alpha * 255);
        }
      }
    }
    return pngFromRaw(output, left.info);
  }
  const opacity = view === 'fade' ? Math.max(0, Math.min(1, Number(options.opacity || 0) / 100)) : 1;
  for (let index = 0; index < output.length; index += 4) {
    const overlayAlpha = right.data[index + 3] / 255 * opacity;
    const baseAlpha = left.data[index + 3] / 255;
    const alpha = overlayAlpha + baseAlpha * (1 - overlayAlpha);
    if (!alpha) { output.fill(0, index, index + 4); continue; }
    for (let channel = 0; channel < 3; channel++) output[index + channel] = Math.round((right.data[index + channel] * overlayAlpha + left.data[index + channel] * baseAlpha * (1 - overlayAlpha)) / alpha);
    output[index + 3] = Math.round(alpha * 255);
  }
  return pngFromRaw(output, left.info);
}

async function docxFromChunks(chunks, tracked) {
  const base = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('')] }] }));
  const zip = await JSZip.loadAsync(base);
  let xml = await zip.file('word/document.xml').async('string');
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  let id = 1;
  const paragraphs = chunks.flatMap(chunk => {
    const lines = String(chunk.text).replace(/\n$/, '').split('\n');
    return lines.map(line => {
      const content = escape(line || ' ');
      if (tracked && chunk.type !== 'same') {
        const key = chunk.type === 'added' ? 'ins' : 'del';
        const textKey = chunk.type === 'added' ? 't' : 'delText';
        return '<w:p><w:' + key + ' w:id="' + id++ + '" w:author="Norways Diff Checker" w:date="' + new Date().toISOString() + '"><w:r><w:' + textKey + ' xml:space="preserve">' + content + '</w:' + textKey + '></w:r></w:' + key + '></w:p>';
      }
      const color = chunk.type === 'added' ? '008540' : chunk.type === 'removed' ? 'B00020' : '222222';
      const decoration = chunk.type === 'removed' ? '<w:strike/>' : chunk.type === 'added' ? '<w:u w:val="single"/>' : '';
      return '<w:p><w:r><w:rPr><w:color w:val="' + color + '"/>' + decoration + '</w:rPr><w:t xml:space="preserve">' + content + '</w:t></w:r></w:p>';
    });
  }).join('');
  const replaced = xml.replace(/<w:body>[\s\S]*?(<w:sectPr[\s\S]*?<\/w:sectPr>)<\/w:body>/, '<w:body>' + paragraphs + '$1</w:body>');
  if (replaced === xml) throw new Error('Could not construct the Word export.');
  zip.file('word/document.xml', replaced);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function pdfFromComparison({ title, lines = [], layout, leftText, rightText, chunks = [], imageView }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 40 });
    const bytes = [];
    pdf.on('data', part => bytes.push(part));
    pdf.on('end', () => resolve(Buffer.concat(bytes)));
    pdf.on('error', reject);
    pdf.fontSize(18).fillColor('#222222').text(title); pdf.moveDown();
    if (imageView) {
      const image = pdf.openImage(imageView);
      const maximumWidth = pdf.page.width - 80;
      const maximumHeight = pdf.page.height - pdf.y - 40;
      const scale = Math.min(maximumWidth / image.width, maximumHeight / image.height);
      const width = image.width * scale, height = image.height * scale;
      pdf.image(image, (pdf.page.width - width) / 2, pdf.y, { width, height });
      if (layout || lines.length || chunks.length) {
        pdf.addPage();
        pdf.fontSize(14).fillColor('#222222').text('Comparison details');
        pdf.moveDown();
      }
    }
    if (layout === 'side') {
      const wrap = text => String(text || '').split('\n').flatMap(line => line.match(/.{1,62}/g) || ['']);
      const left = wrap(leftText), right = wrap(rightText);
      const headerY = pdf.y;
      pdf.fontSize(10).text('ORIGINAL', 40, headerY); pdf.text('CHANGED', 310, headerY);
      let y = headerY + 20;
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        if (y > pdf.page.height - 55) { pdf.addPage(); y = 40; }
        pdf.fillColor('#333333').fontSize(8).text(left[index] || '', 40, y, { width: 250, lineBreak: false });
        pdf.text(right[index] || '', 310, y, { width: 250, lineBreak: false });
        y += 12;
      }
    } else if (layout === 'redline') {
      for (const chunk of chunks) {
        pdf.fillColor(chunk.type === 'added' ? '#08783a' : chunk.type === 'removed' ? '#ad2833' : '#333333').fontSize(9);
        for (const line of String(chunk.text).replace(/\n$/, '').split('\n')) pdf.text((chunk.type === 'added' ? '+ ' : chunk.type === 'removed' ? '- ' : '  ') + line);
      }
    } else for (const line of lines) pdf.fillColor('#333333').fontSize(9).text(String(line));
    pdf.end();
  });
}

module.exports = { docxFromChunks, pdfFromComparison, imageViewFromComparison, textFromComparison };
