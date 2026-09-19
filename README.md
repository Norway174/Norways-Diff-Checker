# Norways Diff Checker

Windows Electron comparison workspace. The renderer uses React, TypeScript and Vite; parsing and comparison run in cancellable worker threads. Inputs and projects stay on the local computer.

## Run and build

```powershell
npm ci
npm run check
npm test
npm start
npm run build:dir
npm run build:installer
```

`build:dir` creates an unpacked app in `dist\win-unpacked`. `build:installer` creates `dist\NorwaysDiffCheckerInstaller.exe`. The installer uses committed `HEAD` from this repository while it has no GitHub `origin`. It builds from a Git archive, so commit changes before testing installation. Once a public GitHub `origin` is configured, the generated installer resolves the latest `main` commit and downloads that commit archive. Its source configuration is embedded at installer build time; rebuild the installer after changing `origin`.

The installer downloads and verifies Node 24.8.0, runs `npm ci`, checks and builds the app, then replaces the per-user unpacked program. It writes settings to `%LOCALAPPDATA%\NorwaysDiffChecker\settings` and program files to `%LOCALAPPDATA%\NorwaysDiffChecker\program`. No administrator access is needed. The app launches from the installed program without a network request. The uninstall entry is registered for the current user.

## Current comparison support

- Text and code: pasted or file-backed inputs, line/word/character diff, ignore case/whitespace and literal rules, side-by-side/unified results, individual change acceptance, PDF and text export.
- Images: JPG, PNG, WebP, GIF, HEIC and PDF pages; pixel differences, region list, several overlay views, EXIF, local OCR and PNG export.
- Documents: DOCX, PDF and PPTX text extraction, scanned PDF OCR, text changes, protected PDF password field, PDF and Word redline/tracked export.
- Spreadsheets: XLSX, XLS, CSV, TSV and ODS via SheetJS; sheet selection, row alignment, cell/formula differences, PDF and XLSX change-list export.
- Folders: recursive path and content-hash comparison, exclusions, search/status filters, and opening changed file pairs in a new tab.

The interface has a Welcome chooser, multiple tabs, drag-and-drop pairing, available-input lists, local project snapshots, recent projects, and settings for restoring tabs. It checks the current committed version after launch and offers update actions.

This is an initial implementation. Office rendering and conversion with bundled LibreOffice, advanced image alignment and scan presets, document structure and page-layout comparisons, spreadsheet column alignment, syntax highlighting, and the full requested clean-account installer/UI test matrix remain to be implemented. Do not treat the advanced view names as validated fidelity modes yet.
