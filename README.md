# Norways Diff Checker

A Windows desktop workspace for comparing text, images, documents, spreadsheets, and folders. It uses a frameless Electron window with isolated preload access, a React/TypeScript UI, and worker threads for comparison jobs. Comparisons run locally.

## Development

```powershell
npm ci
npm start
```

`npm run check` checks TypeScript and JavaScript syntax. `npm run build:dir` downloads and verifies the private LibreOffice copy, then produces an unpacked program at `dist\win-unpacked`. The packaged app also contains local OCR language data and native image engines. Launch `Norways Diff Checker.exe` directly from that folder; Electron includes its own runtime, so Node.js is not needed to run the built app.

There is no installer or in-app update mechanism. Installer design can resume when the app is ready for distribution.

## App data

The app creates `%LOCALAPPDATA%\NorwaysDiffChecker` on launch and uses it directly for `preferences.json`, `projects`, Electron user data, and `cache`. If data exists in the former `%LOCALAPPDATA%\NorwaysDiffChecker\settings` folder, the app copies preferences and saved projects into the new layout. The former folder is retained as a backup.

## Comparison workspace

- **Text:** pasted or file-backed text and code, side-by-side or unified diff, word and character precision, syntax highlighting, edits, change navigation and acceptance, ignore rules, and PDF/merged-text export.
- **Images:** JPG, PNG, WebP, GIF, HEIC, and PDF pages, multiple overlay views, pixel threshold and region grouping, manual and automatic alignment, perspective adjustment, OCR, EXIF details, scan presets, and PNG export.
- **Documents:** DOCX, PDF, and PPTX pairs, extracted and rendered views, scanned-page and embedded-image OCR, text and structure changes, PDF page ordering, password-protected PDFs, redline decisions, and PDF/DOCX exports.
- **Excel:** XLSX, XLS, CSV, TSV, and ODS pairs, sheet and formula modes, inserted row and column alignment, sorting, date normalization, redline and multi-pane views, PDF and XLSX exports.
- **Folders:** recursive path, metadata, and content-hash comparison, glob exclusions, filters, search, and opening matched file pairs in tabs. Folder sources are read only.

The Welcome chooser opens by default; Settings can restore the previous tabs instead. Drag and drop and Windows Open With populate tabs. Three or more inputs open a pairing chooser. Project files contain snapshots and options; folder projects keep their root paths and scan manifest.
