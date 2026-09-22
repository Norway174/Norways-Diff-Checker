const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibreOfficeDependency, downloadBytes, installedBytesEstimate, version } = require('../electron/libreoffice-dependency');

test('LibreOffice dependency reports local status and deletes its files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-libreoffice-'));
  const dependency = createLibreOfficeDependency({ root, request() { throw new Error('Download should not run.'); } });
  assert.deepEqual(dependency.status(), { installed: false, version, downloadBytes, installedBytes: 0, installedBytesEstimate });

  const program = path.join(root, 'dependencies', 'libreoffice', 'program');
  fs.mkdirSync(program, { recursive: true });
  fs.writeFileSync(path.join(program, 'soffice.exe'), 'test');
  fs.writeFileSync(path.join(root, 'dependencies', 'libreoffice', 'ndc-dependency.json'), JSON.stringify({ installedBytes: 12345 }));
  assert.equal(dependency.status().installedBytes, 12345);

  const removed = await dependency.remove();
  assert.equal(removed.installed, false);
  assert.equal(fs.existsSync(path.join(root, 'dependencies', 'libreoffice')), false);
});