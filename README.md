# Norways Diff Checker

A Windows desktop workspace for comparing text, images, documents, spreadsheets, and folders. It uses a frameless Electron window with isolated preload access, React/TypeScript UI, and worker threads for comparison jobs. Comparisons run locally. The installed Electron program does not need a separate Node.js installation.

## Development

```powershell
npm ci
npm start
```

`npm run check` checks TypeScript and JavaScript syntax. `npm run build:dir` downloads and verifies the pinned private LibreOffice copy, then produces an unpacked program at `dist\win-unpacked`. It also bundles local OCR language data and native image engines.

## Installer

Run [installer/NorwaysDiffCheckerInstaller.bat](installer/NorwaysDiffCheckerInstaller.bat) with no arguments for its text menu, or use:

```bat
NorwaysDiffCheckerInstaller.bat -install
NorwaysDiffCheckerInstaller.bat -update
NorwaysDiffCheckerInstaller.bat -update-silent
NorwaysDiffCheckerInstaller.bat -uninstall
NorwaysDiffCheckerInstaller.bat -uninstall-keep
NorwaysDiffCheckerInstaller.bat -uninstall-delete
```

Keep `engine.ps1` beside the batch file. `npm run build:installer` copies both scripts to `dist\installer` for distribution. Installation uses the latest **committed** `main` source. With no GitHub `origin`, the source is hardcoded to `D:\NodeJS\Norways Diff Checker` and archived from local `HEAD`; uncommitted edits are excluded. Once this repository has a GitHub `origin`, the installer resolves `main` to an exact commit and downloads its source archive. It does not use GitHub Releases.

The installer builds from `package-lock.json`. If Node 24.8.0 is already available, it uses that copy. Otherwise it offers to download a verified temporary Node build runtime; it does not install Node system-wide. A scheduled `-update-silent` obtains the temporary runtime automatically if needed. The build and native assets are validated before the live program is replaced. A failed fetch or build leaves the installed program in place.

The unpacked program lives at `%LOCALAPPDATA%\NorwaysDiffChecker\program`. Preferences, projects, tab state, logs, and Electron user data live under `%LOCALAPPDATA%\NorwaysDiffChecker\settings`. The batch installer and PowerShell engine sit at the root of `%LOCALAPPDATA%\NorwaysDiffChecker` so updates can replace `program` while the installer runs. Shortcuts and the Installed Apps entry are registered for the current user. Uninstall asks whether to retain settings and saved comparisons.

## Comparison workspace

- **Text:** pasted or file-backed text and code, side-by-side or unified diff, word and character precision, syntax highlighting, edits, change navigation and acceptance, ignore rules, and PDF/merged-text export.
- **Images:** JPG, PNG, WebP, GIF, HEIC, and PDF pages, multiple overlay views, pixel threshold and region grouping, manual and automatic alignment, perspective adjustment, OCR, EXIF details, scan presets, and PNG export.
- **Documents:** DOCX, PDF, and PPTX pairs, extracted and rendered views, scanned-page and embedded-image OCR, text and structure changes, PDF page ordering, password-protected PDFs, redline decisions, and PDF/DOCX exports.
- **Excel:** XLSX, XLS, CSV, TSV, and ODS pairs, sheet and formula modes, inserted row and column alignment, sorting, date normalization, redline and multi-pane views, PDF and XLSX exports.
- **Folders:** recursive path, metadata, and content-hash comparison, glob exclusions, filters, search, and opening matched file pairs in tabs. Folder sources are read only.

The Welcome chooser opens by default; Settings can restore the previous tabs instead. Drag and drop and Windows Open With populate tabs. Three or more inputs open a pairing chooser. Project files contain snapshots and options; folder projects keep their root paths and scan manifest.
