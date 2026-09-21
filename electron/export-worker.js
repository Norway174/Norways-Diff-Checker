const { parentPort, workerData } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const XLSX = require('xlsx');
const { docxFromChunks, imageViewFromComparison, pdfFromComparison } = require('./exporters');

async function run() {
  const { kind, payload, destination, assetRoot } = workerData;
  let output;
  if (kind === 'image') output = await imageViewFromComparison({ ...payload, assetRoot });
  else if (kind === 'pdf') {
    const imageView = payload.imageView ? await imageViewFromComparison({ ...payload.imageView, assetRoot }) : undefined;
    output = await pdfFromComparison({ ...payload, imageView });
  } else if (kind === 'docx') output = await docxFromChunks(payload.chunks, payload.tracked);
  else if (kind === 'xlsx') {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(payload.rows), 'Changes');
    output = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  } else throw new Error('Unknown export type.');
  if (destination) {
    await fsp.writeFile(destination, output);
    parentPort.postMessage({ kind: 'complete' });
  } else parentPort.postMessage({ kind: 'result', output });
}

run().catch(error => parentPort.postMessage({ kind: 'error', error: error.message || String(error) }));