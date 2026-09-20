const { Document, Packer, Paragraph } = require('docx');
const JSZip = require('jszip');
const PDFDocument = require('pdfkit');

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

async function pdfFromComparison({ title, lines = [], layout, leftText, rightText, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 40 });
    const bytes = [];
    pdf.on('data', part => bytes.push(part));
    pdf.on('end', () => resolve(Buffer.concat(bytes)));
    pdf.on('error', reject);
    pdf.fontSize(18).fillColor('#222222').text(title); pdf.moveDown();
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

module.exports = { docxFromChunks, pdfFromComparison };
